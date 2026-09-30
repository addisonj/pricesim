// Example: an `orders` service with three APIs.
//
//   orders (own k8s node pool: orders-nodes)
//   ├── dynamodb:orders            (on-demand table, 1 GSI)
//   ├── s3:receipts                (S3 Standard bucket)
//   ├── inventory                  (pods only, on the shared node pool)
//   └── ledger                     (pods on the shared node pool)
//       └── aurora-postgresql:ledger   (2 × db.r7g.large, writer + reader)
//
// Run:  pnpm cli eval examples/orders-platform.ts --json out.json
import { pricing, q, scenario, series, u, workload } from 'pricesim'
import { edge, gauge, nodePool, pods, request, service } from 'pricesim/model'
import { auroraInstances, auroraPostgres, dynamoTable, ec2, interAz, s3Bucket } from 'pricesim/aws'

// per-request CPU cost: milliseconds of one core (1 core·ms = 1000 millicore·ms), and per-item variants
const coreMs = u.vCPU.mul(u.ms)
const coreMsPerItem = coreMs.div(u.count)

// ---------- Kubernetes capacity ----------
const system = { cpu: q(400, u.millicore), memory: q(1.5, u.GiB) }

/** node pool dedicated to the orders service */
const ordersNodes = nodePool('orders-nodes', {
  instance: ec2['m7g.2xlarge'],
  min: 3,
  azs: 3,
  reserved: system,
  maxPods: 58,
  packingEfficiency: 0.85,
})

/** node pool shared by the internal inventory and ledger services */
const sharedNodes = nodePool('shared-nodes', {
  instance: ec2['m7g.xlarge'],
  min: 3,
  azs: 3,
  reserved: system,
  maxPods: 58,
  packingEfficiency: 0.85,
})

// ---------- internal service 1: inventory (pods only) ----------
const inventory = service('inventory', {
  pools: {
    pods: pods('inventory', {
      on: sharedNodes,
      request: { cpu: q(500, u.millicore), memory: q(1, u.GiB) },
      minReplicas: 2,
      targetUtilization: 0.6,
    }),
  },
  gauges: { skus: gauge(u.count) },
  requests: ({ pools }) => ({
    reserve: request({ items: u.count }, (r) => ({
      use: [pools.pods.cpu(q(0.4, coreMs).add(q(0.15, coreMsPerItem).mul(r.items)))],
    })),
    check: request({ items: u.count }, (r) => ({
      use: [pools.pods.cpu(q(0.2, coreMs).add(q(0.05, coreMsPerItem).mul(r.items)))],
    })),
    release: request({ items: u.count }, (r) => ({
      use: [pools.pods.cpu(q(0.3, coreMs).add(q(0.1, coreMsPerItem).mul(r.items)))],
    })),
  }),
  // in-memory stock cache: ~2 KB per SKU
  gaugeUse: (g, { pools }) => [pools.pods.memory(g.skus.mul(q(2, u.KB.div(u.count))))],
})

// ---------- internal service 2: ledger (pods + Aurora PostgreSQL) ----------
const ledgerDb = auroraPostgres('ledger', { instance: auroraInstances['db.r7g.large'], instances: 2 })

const ledger = service('ledger', {
  deps: { db: ledgerDb },
  pools: {
    pods: pods('ledger', {
      on: sharedNodes,
      request: { cpu: q(500, u.millicore), memory: q(1, u.GiB) },
      minReplicas: 2,
      targetUtilization: 0.6,
    }),
  },
  gauges: { entries: gauge(u.count) },
  requests: ({ deps, pools }) => ({
    /** double-entry: each call writes `entries` rows in one transaction */
    record: request({ entries: u.count }, (r) => ({
      use: [pools.pods.cpu(q(0.8, coreMs).add(q(0.3, coreMsPerItem).mul(r.entries)))],
      calls: [
        deps.db.query({
          ioReads: q(1, u.op.div(u.count)).mul(r.entries),
          ioWrites: q(3, u.op.div(u.count)).mul(r.entries),
          cpu: q(1.5, coreMsPerItem).mul(r.entries),
        }),
      ],
    })),
    balance: request({}, () => ({
      use: [pools.pods.cpu(q(0.5, coreMs))],
      calls: [deps.db.query({ ioReads: q(4, u.op), ioWrites: q(0, u.op), cpu: q(2, coreMs) })],
    })),
  }),
  // ~300 bytes per ledger row including indexes
  gaugeMap: (g, { deps }) => [deps.db.gauges.stored(g.entries.mul(q(300, u.byte.div(u.count))))],
})

// ---------- the main service: orders (own node pool, 3 APIs) ----------
const ordersTable = dynamoTable('orders', { gsis: 1 })
const receipts = s3Bucket('receipts')

export const orders = service('orders', {
  deps: { table: ordersTable, receipts, inventory, ledger },
  pools: {
    api: pods('orders-api', {
      on: ordersNodes,
      request: { cpu: q(1000, u.millicore), memory: q(2, u.GiB) },
      minReplicas: 3,
      targetUtilization: 0.6,
    }),
  },
  gauges: { orders: gauge(u.count), skus: gauge(u.count) },
  requests: ({ deps, pools }) => ({
    createOrder: request({ bytes: u.byte, items: u.count }, (r) => ({
      use: [pools.api.cpu(q(4, coreMs).add(q(0.5, coreMsPerItem).mul(r.items)))],
      calls: [
        deps.table.write({ bytes: r.bytes }),
        // 30% of orders upload a ~20 KB receipt
        deps.receipts.put({ bytes: q(20, u.KB) }).times(0.3),
        deps.inventory.reserve({ items: r.items }),
        deps.ledger.record({ entries: q(2, u.count) }),
      ],
      // client → orders through a zonal load balancer, and orders → internal services (2 KB each way)
      net: [edge(r.bytes, { kind: 'uniformClients', azs: 3 }), edge(q(4, u.KB), { kind: 'uniformClients', azs: 3 })],
    })),
    getOrder: request({ bytes: u.byte }, (r) => ({
      use: [pools.api.cpu(q(1.5, coreMs))],
      calls: [deps.table.read({ bytes: r.bytes }), deps.receipts.get({ bytes: q(20, u.KB) }).times(0.05)],
      net: [edge(r.bytes, { kind: 'uniformClients', azs: 3 })],
    })),
    listOrders: request({ pageSize: u.count }, (r) => ({
      use: [pools.api.cpu(q(3, coreMs).add(q(0.1, coreMsPerItem).mul(r.pageSize)))],
      calls: [deps.table.query({ bytes: q(1, u.KB.div(u.count)).mul(r.pageSize) }), deps.ledger.balance({})],
      net: [edge(q(1, u.KB.div(u.count)).mul(r.pageSize), { kind: 'uniformClients', azs: 3 })],
    })),
  }),
  gaugeMap: (g, { deps }) => [
    // ~2 KB per order in the base table, repeated in the GSI
    deps.table.gauges.stored(g.orders.mul(q(4, u.KB.div(u.count)))),
    // 30% of orders keep a 20 KB receipt
    deps.receipts.gauges.stored(g.orders.mul(q(6, u.KB.div(u.count)))),
    deps.ledger.gauges.entries(g.orders.mul(2)),
    deps.inventory.gauges.skus(g.skus),
  ],
})

// ---------- workload: one month, hourly steps, diurnal traffic ----------
const perSecond = u.req.div(u.s)

export const typical = workload(orders, {
  requests: {
    createOrder: {
      rate: series.diurnal({ mean: q(150, perSecond), peakToMean: 2 }),
      attrs: { bytes: q(2, u.KB), items: q(3, u.count) },
    },
    getOrder: {
      rate: series.diurnal({ mean: q(1200, perSecond), peakToMean: 1.8 }),
      attrs: { bytes: q(2, u.KB) },
    },
    listOrders: {
      rate: series.diurnal({ mean: q(80, perSecond), peakToMean: 2 }),
      attrs: { pageSize: q(25, u.count) },
    },
  },
  // retained orders are derived from the createOrder rate: 30 days of orders
  gauges: ({ rate }) => ({
    orders: rate.createOrder.mul(q(30, u.day)).mul(q(1, u.count.div(u.req))),
    skus: q(2e6, u.count),
  }),
})

export default scenario({
  name: 'orders-platform',
  description:
    'orders service (3 APIs) on its own node pool; DynamoDB + S3; inventory and ledger (Aurora) on a shared node pool',
  root: orders,
  workload: typical,
  pricing: pricing({ region: 'us-east-1' }),
  interAz,
})
