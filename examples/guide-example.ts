// The model built step by step in docs/guide.md: a file-upload service.
//
//   uploads (pods on the `general` k8s node pool)
//   ├── alb:uploads         (Application Load Balancer: hourly fixed charge + LCUs)
//   ├── s3:files            (S3 Standard bucket)
//   ├── queue:thumbnails    (a hand-written offering: an illustrative per-request queue)
//   └── search              (its own EC2 instance pool, sized by the memory its index holds)
//
// Run:  pnpm cli eval examples/guide-example.ts
import {
  charge,
  dimension,
  fee,
  freeTier,
  minimum,
  priceBook,
  pricing,
  q,
  scenario,
  series,
  tiered,
  u,
  workload,
} from 'pricesim'
import { bill, edge, gauge, instancePool, nodePool, offering, pods, request, service } from 'pricesim/model'
import { applicationLoadBalancer, ec2, interAz, s3Bucket } from 'pricesim/aws'

// ---------- units used below ----------
/** CPU time per request, in milliseconds of one core (1 core·ms = 1000 millicore·ms) */
const coreMs = u.vCPU.mul(u.ms)
const perSecond = u.req.div(u.s)

// ---------- step 1: an offering of our own ----------
/** Illustrative queue pricing (not a real price list): first million requests free, then $0.40 per million. */
const queueRequests = dimension('example.queue.requests', u.req, freeTier(1e6, 0.4e-6), { family: 'example.queue' })

const thumbnailQueue = offering('queue:thumbnails', {
  requests: () => ({
    send: request({}, () => ({ bill: [bill(queueRequests, q(1, u.req))] })),
  }),
})

// ---------- step 2: capacity ----------
/** Shared Kubernetes node pool. */
const general = nodePool('general', {
  instance: ec2['m7g.xlarge'],
  min: 3,
  azs: 3,
  reserved: { cpu: q(400, u.millicore), memory: q(1.5, u.GiB) },
  maxPods: 58,
  packingEfficiency: 0.85,
})

// ---------- step 3: a service on its own instance pool ----------
/** Search keeps ~1 KB of index per file in memory, on memory-optimized instances. */
const search = service('search', {
  pools: {
    nodes: instancePool('search-nodes', { instance: ec2['r7g.large'], min: 2, loadFactor: 0.7, azs: 2 }),
  },
  gauges: { docs: gauge(u.count) },
  requests: ({ pools }) => ({
    index: request({}, () => ({ use: [pools.nodes.cpu(q(0.5, coreMs))] })),
    lookup: request({}, () => ({ use: [pools.nodes.cpu(q(4, coreMs))] })),
  }),
  gaugeUse: (g, { pools }) => [pools.nodes.memory(g.docs.mul(q(1, u.KB.div(u.count))))],
})

// ---------- step 4: the root service ----------
const lb = applicationLoadBalancer('uploads')
const files = s3Bucket('files')

export const uploads = service('uploads', {
  deps: { lb, files, queue: thumbnailQueue, search },
  pools: {
    api: pods('uploads-api', {
      on: general,
      request: { cpu: q(1000, u.millicore), memory: q(2, u.GiB) },
      minReplicas: 2,
      targetUtilization: 0.6,
    }),
  },
  gauges: { files: gauge(u.count) },
  requests: ({ deps, pools }) => ({
    upload: request({ bytes: u.byte }, (r) => ({
      // 3 core·ms fixed + 2 core·ms per MB received
      use: [pools.api.cpu(q(3, coreMs).add(r.bytes.mul(q(2, coreMs.div(u.MB)))))],
      calls: [
        deps.lb.forward({ bytes: r.bytes }),
        deps.files.put({ bytes: r.bytes }),
        deps.queue.send({}),
        deps.search.index({}),
      ],
      // clients in 3 AZs reach pods in 3 AZs: 2/3 of the bytes cross an AZ boundary
      net: [edge(r.bytes, { kind: 'uniformClients', azs: 3 })],
    })),
    download: request({ bytes: u.byte }, (r) => ({
      use: [pools.api.cpu(q(1, coreMs))],
      calls: [deps.lb.forward({ bytes: r.bytes }), deps.files.get({ bytes: r.bytes })],
      net: [edge(r.bytes, { kind: 'uniformClients', azs: 3 })],
    })),
    find: request({}, () => ({
      use: [pools.api.cpu(q(0.5, coreMs))],
      calls: [deps.search.lookup({})],
    })),
  }),
  // every stored file is ~500 KB in S3 and one document in the search index
  gaugeMap: (g, { deps }) => [
    deps.files.gauges.stored(g.files.mul(q(500, u.KB.div(u.count)))),
    deps.search.gauges.docs(g.files),
  ],
})

// ---------- step 5: the workload ----------
export const typical = workload(uploads, {
  requests: {
    upload: {
      rate: series.diurnal({ mean: q(20, perSecond), peakToMean: 2 }),
      attrs: { bytes: q(500, u.KB) },
    },
    download: {
      rate: series.diurnal({ mean: q(200, perSecond), peakToMean: 1.5 }),
      attrs: { bytes: q(500, u.KB) },
    },
    find: { rate: series.constant(q(50, perSecond)), attrs: {} },
  },
  // files kept for 30 days: a gauge derived from the mean upload rate
  gauges: ({ rate }) => ({ files: rate.upload.mul(q(30, u.day)).mul(q(1, u.count.div(u.req))) }),
})

// ---------- step 6: the scenario ----------
export default scenario({
  name: 'uploads',
  description: 'file uploads on a shared k8s node pool; S3, an ALB, a queue, and a search tier on EC2',
  root: uploads,
  workload: typical,
  pricing: pricing({ region: 'us-east-1' }),
  interAz,
})

// ---------- tenants: two customers sharing the same deployment ----------
const perTenant = (uploadsPerSecond: number) =>
  workload(uploads, {
    requests: {
      upload: { rate: series.constant(q(uploadsPerSecond, perSecond)), attrs: { bytes: q(500, u.KB) } },
    },
    gauges: ({ rate }) => ({ files: rate.upload.mul(q(30, u.day)).mul(q(1, u.count.div(u.req))) }),
  })

export const shared = scenario({
  name: 'uploads-shared',
  root: uploads,
  tenants: [
    { id: 'small', workload: perTenant(1) },
    { id: 'large', workload: perTenant(19) },
  ],
  pricing: pricing(),
  interAz,
})

// ---------- step 7: a price book: what we charge, and the margin ----------
export const uploadPrices = priceBook(uploads, {
  name: 'uploads list prices',
  meters: (m) => ({
    uploadedGB: m.requests({ upload: (r) => r.bytes }, u.GB),
    downloadedGB: m.requests({ download: (r) => r.bytes }, u.GB),
    // files held: file-months (the gauge's level × time); its cost is S3 storage and the search index
    fileMonths: m.gauge('files', u.count.mul(u.month), { costFrom: ['stored', 'docs', 'memory'] }),
  }),
  options: { support: { values: ['standard', 'premium'], default: 'standard' } },
  prices: [
    charge(
      'uploadedGB',
      tiered([
        { upTo: 10_000, rate: 0.02 },
        { upTo: null, rate: 0.015 },
      ]),
    ),
    charge('downloadedGB', 0.01),
    charge('fileMonths', freeTier(100_000, 0.0001)),
    fee(500, { when: { support: 'premium' }, name: 'premium support' }),
    minimum(50),
  ],
})

/** the shared deployment, billed per customer under the price book */
export const sharedPriced = scenario({
  name: 'uploads-shared-priced',
  root: uploads,
  tenants: [
    { id: 'small', workload: perTenant(1) },
    { id: 'large', workload: perTenant(19), plan: { support: 'premium' } },
  ],
  pricing: pricing(),
  interAz,
  priceBook: uploadPrices,
})
