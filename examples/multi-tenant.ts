// Example: a multi-tenant event API shared by 200 Zipf-sized tenants.
//
//   events (pods on a shared node pool)
//   ├── dynamodb:events   (on-demand table: event index)
//   └── s3:payloads       (S3 Standard: event payloads)
//
// Tenants publish and fetch events. Their sizes follow a Zipf distribution: a few large tenants and a long
// tail of small ones. Payload sizes are log-normal per request. `dedicatedVsShared()` compares one shared
// deployment against giving every tenant its own.
//
// Run:  pnpm cli eval examples/multi-tenant.ts
import { evaluate, pricing, q, scenario, series, u, workload, zipfTenants, dist, withWorkload } from 'pricesim'
import { gauge, nodePool, pods, request, service } from 'pricesim/model'
import { dynamoTable, ec2, s3Bucket } from 'pricesim/aws'

const coreMs = u.vCPU.mul(u.ms)
const perSecond = u.req.div(u.s)

const nodes = nodePool('events-nodes', {
  instance: ec2['m7g.xlarge'],
  min: 3,
  azs: 3,
  reserved: { cpu: q(400, u.millicore), memory: q(1.5, u.GiB) },
  maxPods: 58,
  packingEfficiency: 0.85,
})

const index = dynamoTable('events')
const payloads = s3Bucket('payloads')

export const events = service('events', {
  deps: { index, payloads },
  pools: {
    api: pods('events-api', {
      on: nodes,
      request: { cpu: q(500, u.millicore), memory: q(1, u.GiB) },
      minReplicas: 3,
      targetUtilization: 0.6,
    }),
  },
  gauges: { events: gauge(u.count) },
  requests: ({ deps, pools }) => ({
    publish: request({ bytes: u.byte }, (r) => ({
      use: [pools.api.cpu(q(0.8, coreMs))],
      // index entry (1 KB) plus the payload object
      calls: [deps.index.write({ bytes: q(1, u.KB) }), deps.payloads.put({ bytes: r.bytes })],
    })),
    fetch: request({ bytes: u.byte }, (r) => ({
      use: [pools.api.cpu(q(0.5, coreMs))],
      calls: [deps.index.read({ bytes: q(1, u.KB) }), deps.payloads.get({ bytes: r.bytes })],
    })),
  }),
  gaugeMap: (g, { deps }) => [
    deps.index.gauges.stored(g.events.mul(q(1, u.KB.div(u.count)))),
    // average payload ≈ the log-normal mean below (≈ 2.3 KB)
    deps.payloads.gauges.stored(g.events.mul(q(2.3, u.KB.div(u.count)))),
  ],
})

/** 200 tenants sharing 2,000 publishes/s; each fetches 3× what it publishes and keeps 7 days of events */
export const TOTAL_PUBLISH = 2000
const payloadSize = dist.lognormal({ median: q(1, u.KB), p99: q(16, u.KB) })

export const tenants = zipfTenants({
  count: 200,
  seed: 7,
  make: ({ share }) =>
    workload(events, {
      requests: {
        publish: {
          rate: series.diurnal({ mean: q(TOTAL_PUBLISH * share, perSecond), peakToMean: 1.5 }),
          attrs: { bytes: payloadSize },
        },
        fetch: {
          rate: series.diurnal({ mean: q(3 * TOTAL_PUBLISH * share, perSecond), peakToMean: 1.5 }),
          attrs: { bytes: payloadSize },
        },
      },
      gauges: ({ rate }) => ({ events: rate.publish.mul(q(7, u.day)).mul(q(1, u.count.div(u.req))) }),
      samples: 16,
    }),
})

export const shared = scenario({
  name: 'multi-tenant-events',
  description: '200 Zipf-sized tenants on one shared deployment',
  root: events,
  tenants,
  pricing: pricing(),
})

/** Monthly cost of one shared deployment vs a dedicated deployment per tenant. */
export const dedicatedVsShared = () => {
  const s = evaluate(shared)
  const dedicated = tenants.map((t) => evaluate(withWorkload(shared, t.workload, t.id)))
  const dedicatedTotal = dedicated.reduce((a, r) => a + r.total, 0)
  return {
    shared: { total: s.total, used: s.used, idle: s.idle },
    dedicated: { total: dedicatedTotal, idle: dedicated.reduce((a, r) => a + r.idle, 0) },
    tenants: s.tenants!,
  }
}

export default shared
