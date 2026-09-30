// A worked example: an event-ingestion service, what it costs to run on AWS, and what we charge for it.
//
//   pricesim eval model.ts                          cost tree, pools, and revenue/margin for one customer
//   pricesim sweep model.ts --var traffic=1,4,16    how cost and pools move with traffic
//   pricesim unit-cost model.ts --rate 100          cost per million publishes and queries
//   tsx report.ts                                   price, cost and margin by customer size, and over a
//                                                   simulated customer base
//
// The system: clients publish event batches through a load balancer to ingest pods on a shared Kubernetes
// cluster; a storage tier (EC2 with gp3 disks) keeps the last day hot, replicated to a second AZ; older data
// goes to S3 in 8 MB segments. Queries read recent events from the storage tier.
import {
  ceil,
  charge,
  dist,
  fee,
  minimum,
  param,
  priceBook,
  pricing,
  q,
  retained,
  scenario,
  series,
  tiered,
  u,
  workload,
  type Workload,
} from 'pricesim'
import { edge, gauge, instancePool, nodePool, pods, request, service } from 'pricesim/model'
import { applicationLoadBalancer, ec2, gp3, interAz, s3Bucket } from 'pricesim/aws'

const coreMs = u.vCPU.mul(u.ms)
const perSecond = u.req.div(u.s)

// ---------- inputs we're unsure of (sweep them: pricesim sweep model.ts --var ingestCpuPerMB=5,10,20) ----------
/** CPU the ingest pods spend per MB of events */
const ingestCpuPerMB = param('ingestCpuPerMB', q(10, coreMs))
/** how long events stay hot on the storage tier before only S3 has them */
const hotRetention = param('hotRetention', q(1, u.day))
/** traffic multiplier for every request type (1 = the typical customer below) */
const traffic = param('traffic', q(1, u.one))

// ---------- capacity ----------
const cluster = nodePool('general', {
  instance: ec2['m7g.xlarge'],
  min: 3,
  azs: 3,
  reserved: { cpu: q(400, u.millicore), memory: q(1.5, u.GiB) },
  maxPods: 58,
  packingEfficiency: 0.85,
})

const storageNodes = instancePool('storage-nodes', {
  instance: ec2['m7g.2xlarge'],
  min: 2,
  loadFactor: 0.7,
  azs: 2,
  volumes: [{ type: gp3, size: q(2, u.TiB) }],
})

// ---------- services ----------
const segmentBytes = q(8, u.MB)

/** Hot storage: replicated to a second AZ, flushed to S3 in segments. */
const storage = service('storage', {
  deps: { archive: s3Bucket('events-archive') },
  pools: { nodes: storageNodes },
  gauges: { hot: gauge(u.byte), archived: gauge(u.byte) },
  requests: ({ deps, pools }) => ({
    append: request({ bytes: u.byte }, (r) => ({
      use: [pools.nodes.ebsBandwidth(r.bytes.mul(2)), pools.nodes.cpu(q(0.2, coreMs))],
      // one copy crosses to the other AZ; each end gets the bytes as network demand
      net: [edge(r.bytes, { kind: 'replicate', rf: 2 }, { from: pools.nodes, to: pools.nodes })],
      // one S3 PUT per 8 MB segment
      calls: [deps.archive.put({ bytes: segmentBytes }).times(r.bytes.div(segmentBytes))],
    })),
    read: request({ bytes: u.byte }, (r) => ({
      use: [pools.nodes.cpu(q(0.5, coreMs)), pools.nodes.network(r.bytes)],
    })),
  }),
  gaugeUse: (g, { pools }) => [pools.nodes.disk(g.hot.mul(2))],
  gaugeMap: (g, { deps }) => [deps.archive.gauges.stored(g.archived)],
})

/** The public API: publish event batches, query recent events. */
export const events = service('events', {
  deps: { lb: applicationLoadBalancer('events'), storage },
  pools: {
    ingest: pods('ingest', {
      on: cluster,
      request: { cpu: q(1000, u.millicore), memory: q(2, u.GiB) },
      minReplicas: 2,
      targetUtilization: 0.6,
    }),
  },
  gauges: { stored: gauge(u.byte) },
  requests: ({ deps, pools }) => ({
    publish: request({ bytes: u.byte }, (r) => ({
      use: [pools.ingest.cpu(q(0.5, coreMs).add(r.bytes.div(q(1, u.MB)).mul(ingestCpuPerMB)))],
      calls: [deps.lb.forward({ bytes: r.bytes }), deps.storage.append({ bytes: r.bytes })],
      // clients in 3 AZs, pods in 3 AZs: 2/3 of the bytes cross an AZ
      net: [edge(r.bytes, { kind: 'uniformClients', azs: 3 })],
    })),
    query: request({ bytes: u.byte }, (r) => ({
      use: [pools.ingest.cpu(q(1, coreMs))],
      calls: [deps.lb.forward({ bytes: r.bytes }), deps.storage.read({ bytes: r.bytes })],
      net: [edge(r.bytes, { kind: 'uniformClients', azs: 3 })],
    })),
  }),
  // everything stored: the hot window on the storage tier, all of it in S3
  gaugeMap: (g, { deps }) => [
    deps.storage.gauges.hot(g.stored.mul(hotRetention.div(q(30, u.day)))),
    deps.storage.gauges.archived(g.stored),
  ],
})

// ---------- workloads ----------
/** A customer publishing `mbps` MB/s of events in batches (sizes vary), querying 20% of it back, keeping 30 days. */
export const customer = (mbps: number): Workload =>
  workload(events, {
    requests: {
      publish: {
        rate: series.diurnal({ mean: q(mbps * 10, perSecond).mul(traffic), peakToMean: 1.6 }),
        // batches of ~100 KB: a mix, so the per-request costs are averaged over real sizes
        attrs: { bytes: dist.lognormal({ median: q(80, u.KB), p99: q(1, u.MB) }) },
      },
      query: {
        rate: series.constant(q(mbps * 2, perSecond).mul(traffic)),
        attrs: { bytes: q(100, u.KB) },
      },
    },
    // 30 days of published bytes; follows the publish rate when it's swept
    gauges: ({ rate }) => ({
      stored: retained({ rate: rate.publish.mul(q(100, u.KB.div(u.req))), retention: q(30, u.day) }),
    }),
  })

// ---------- what we charge ----------
export const prices = priceBook(events, {
  name: 'list prices',
  meters: (m) => ({
    ingestGB: m.requests({ publish: (r) => r.bytes }, u.GB),
    // queries in 64 KB units
    queryUnits: m.requests({ query: (r) => ceil(r.bytes.div(q(64, u.KB))) }, u.one),
    storedGBMonths: m.gauge('stored', u.GB.mul(u.month)),
  }),
  options: { support: { values: ['standard', 'premium'], default: 'standard' } },
  prices: [
    charge(
      'ingestGB',
      tiered([
        { upTo: 10_000, rate: 0.08 },
        { upTo: 100_000, rate: 0.06 },
        { upTo: null, rate: 0.05 },
      ]),
    ),
    charge('queryUnits', 0.4e-6),
    charge('storedGBMonths', 0.09),
    fee(1_000, { when: { support: 'premium' }, name: 'premium support' }),
    minimum(200),
  ],
})

// ---------- scenarios ----------
/** One 5 MB/s customer on its own deployment (the CLI evaluates this one). */
export default scenario({
  name: 'events',
  description: 'event ingestion: ALB → ingest pods on k8s → replicated storage tier → S3',
  root: events,
  workload: customer(5),
  pricing: pricing({ familyDiscounts: { 'aws.ec2': 0.25 } }), // ~ a 1-year Savings Plan
  interAz,
  priceBook: prices,
})
