// Realistic model: 8 base dimensions, 1 offering, 3 nested services, 20 request types.
import { type Expr, q, u, sym, param, max, ceil, opaque, request, gauge, pool, edge, offering, service, dimension, bill, parseQuantity } from '#core'
import { ec2 } from './catalog.gen.js'

// ---- offering: S3 Express One Zone ----
const storage = dimension('aws.s3express.storage', u.GB.mul(u.month))
const putReqs = dimension('aws.s3express.put', u.req)
const getReqs = dimension('aws.s3express.get', u.req)
const uploadBytes = dimension('aws.s3express.upload', u.GB)
const retrievalBytes = dimension('aws.s3express.retrieval', u.GB)

export const s3x = offering('aws.s3express', {
  gauges: { stored: gauge(u.byte) },
  requests: {
    put: request({ bytes: u.byte }, (r) => ({
      bill: [bill(putReqs, q(1, u.req)), bill(uploadBytes, max(q(0, u.byte), r.bytes.sub(q(512, u.KiB))))],
    })),
    get: request({ bytes: u.byte }, (r) => ({
      bill: [bill(getReqs, q(1, u.req)), bill(retrievalBytes, max(q(0, u.byte), r.bytes.sub(q(512, u.KiB))))],
    })),
  },
})
// storage billing: bytes stored × time
export const storageBill = (stored: Expr<{ byte: 1 }>) => bill(storage, stored.mul(q(1, u.month)))

// ---- service 1: logStore (7 request types) ----
const cpuMs = u.millicore.mul(u.ms)
const perByte = cpuMs.div(u.byte)
const loadFactor = param('loadFactor', q(0.6, u.one))
const segmentBytes = param('segmentBytes', q(8, u.MiB))

export const logStore = service('logStore', {
  deps: { s3x },
  pools: { nodes: pool('logStore.nodes', { instance: ec2['m7g.2xlarge'], min: 3, azs: 3, loadFactor }) },
  gauges: { streams: gauge(u.stream), retained: gauge(u.byte), connections: gauge(u.count) },
  requests: ({ deps, pools }) => ({
    append: request({ bytes: u.byte }, (r) => ({
      use: [pools.nodes.cpu(q(15, cpuMs).add(r.bytes.mul(q(0.002, perByte)))), pools.nodes.network(r.bytes.mul(q(3, u.one)))],
      calls: [deps.s3x.requests.put({ bytes: segmentBytes }).times(r.bytes.div(segmentBytes))],
      net: [edge({ bytes: r.bytes, pattern: 'uniformClients' }), edge({ bytes: r.bytes.mul(q(2, u.one)), pattern: 'replicate', rf: 3 })],
    })),
    read: request({ bytes: u.byte, cacheHit: u.one }, (r) => ({
      use: [pools.nodes.cpu(q(8, cpuMs).add(r.bytes.mul(q(0.001, perByte)))), pools.nodes.network(r.bytes)],
      calls: [deps.s3x.requests.get({ bytes: segmentBytes }).times(q(1, u.one).sub(r.cacheHit).mul(r.bytes.div(segmentBytes)))],
    })),
    compact: request({ segments: u.count }, (r) => ({
      use: [pools.nodes.cpu(q(200, cpuMs).mul(r.segments.div(q(1, u.count))))],
      calls: [
        deps.s3x.requests.get({ bytes: segmentBytes }).times(r.segments.div(q(1, u.count))),
        deps.s3x.requests.put({ bytes: segmentBytes }).times(q(1, u.one)),
      ],
    })),
    createStream: request({}, () => ({ use: [pools.nodes.cpu(q(50, cpuMs))] })),
    deleteStream: request({}, () => ({ use: [pools.nodes.cpu(q(30, cpuMs))] })),
    listStreams: request({ page: u.count }, (r) => ({ use: [pools.nodes.cpu(q(5, cpuMs).mul(r.page.div(q(1, u.count))))] })),
    trim: request({ bytes: u.byte }, (r) => ({ use: [pools.nodes.cpu(q(2, cpuMs).add(r.bytes.mul(q(0.0001, perByte))))] })),
  }),
  gaugeUse: (g, { pools }) => [
    pools.nodes.memory(g.streams.mul(q(64, u.KB.div(u.stream)))),
    pools.nodes.memory(g.connections.mul(q(256, u.KB.div(u.count)))),
  ],
  gaugeMap: (g, { deps }) => [deps.s3x.gauges.stored(g.retained)],
})

// ---- service 2: streamApi (7 request types) ----
export const streamApi = service('streamApi', {
  deps: { store: logStore },
  pools: { fe: pool('streamApi.fe', { instance: ec2['c7g.xlarge'], min: 2, azs: 3, loadFactor }) },
  gauges: { topics: gauge(u.stream), sessions: gauge(u.count) },
  requests: ({ deps, pools }) => ({
    produce: request({ bytes: u.byte, batch: u.count }, (r) => ({
      use: [pools.fe.cpu(q(40, cpuMs).add(r.bytes.mul(r.batch).div(q(1, u.count)).mul(q(0.001, perByte))))],
      calls: [deps.store.requests.append({ bytes: r.bytes.mul(r.batch).div(q(1, u.count)) })],
    })),
    consume: request({ bytes: u.byte, cacheHit: u.one }, (r) => ({
      use: [pools.fe.cpu(q(30, cpuMs)), pools.fe.network(r.bytes)],
      calls: [deps.store.requests.read({ bytes: r.bytes, cacheHit: r.cacheHit })],
    })),
    commitOffset: request({}, () => ({ use: [pools.fe.cpu(q(3, cpuMs))] })),
    createTopic: request({ partitions: u.stream }, (r) => ({
      use: [pools.fe.cpu(q(20, cpuMs))],
      calls: [deps.store.requests.createStream({}).times(r.partitions.div(q(1, u.stream)))],
    })),
    deleteTopic: request({ partitions: u.stream }, (r) => ({
      calls: [deps.store.requests.deleteStream({}).times(r.partitions.div(q(1, u.stream)))],
    })),
    describe: request({}, () => ({ use: [pools.fe.cpu(q(4, cpuMs))], calls: [deps.store.requests.listStreams({ page: q(1, u.count) })] })),
    fetchMeta: request({}, () => ({ use: [pools.fe.cpu(q(2, cpuMs))] })),
  }),
  gaugeMap: (g, { deps }) => [deps.store.gauges.streams(g.topics), deps.store.gauges.connections(g.sessions)],
})

// ---- service 3: gateway (6 request types) ----
export const gateway = service('gateway', {
  deps: { api: streamApi },
  pools: { gw: pool('gateway.gw', { instance: ec2['c7g.large'], min: 2, azs: 3, loadFactor }) },
  gauges: { clients: gauge(u.count) },
  requests: ({ deps, pools }) => ({
    httpProduce: request({ bytes: u.byte, batch: u.count }, (r) => ({
      use: [pools.gw.cpu(q(60, cpuMs)), pools.gw.network(r.bytes.mul(r.batch).div(q(1, u.count)))],
      calls: [deps.api.requests.produce({ bytes: r.bytes, batch: r.batch })],
    })),
    httpConsume: request({ bytes: u.byte }, (r) => ({
      use: [pools.gw.cpu(q(50, cpuMs)), pools.gw.network(r.bytes)],
      calls: [deps.api.requests.consume({ bytes: r.bytes, cacheHit: q(0.9, u.one) })],
    })),
    auth: request({}, () => ({ use: [pools.gw.cpu(q(10, cpuMs))] })),
    health: request({}, () => ({ use: [pools.gw.cpu(q(1, cpuMs))] })),
    webhookDeliver: request({ bytes: u.byte }, (r) => ({
      use: [pools.gw.cpu(q(25, cpuMs)), pools.gw.network(r.bytes)],
      calls: [deps.api.requests.consume({ bytes: r.bytes, cacheHit: q(1, u.one) }), deps.api.requests.commitOffset({})],
    })),
    batchIngest: request({ bytes: u.byte, records: u.count }, (r) => ({
      use: [pools.gw.cpu(q(100, cpuMs).add(r.bytes.mul(q(0.0005, perByte))))],
      calls: [deps.api.requests.produce({ bytes: r.bytes.div(r.records).mul(q(1, u.count)), batch: r.records })],
    })),
  }),
  gaugeMap: (g, { deps }) => [deps.api.gauges.sessions(g.clients)],
})

// ---- sizing relations and a monthly cost, fully typed ----
const produceRate = sym('produceRate', u.req.div(u.s))
const cpuPerReq = q(40, cpuMs.div(u.req))
const cpuDemand = produceRate.mul(cpuPerReq) // (req/s)·(millicore·s/req) → millicore
const nodes = ceil(max(q(3, u.count), cpuDemand.div(ec2['m7g.2xlarge'].cpu.div(q(1, u.count)).mul(loadFactor))))
export const monthlyNodeCost = nodes.mul(ec2['m7g.2xlarge'].price).mul(q(1, u.month)).div(q(1, u.count)) // Expr<{USD:1}>
export const typedCheck: import('#core').Expr<{ USD: 1 }> = monthlyNodeCost

const p99 = opaque('queueP99', { inputs: { produceRate, nodes }, unit: u.ms }, ({ produceRate, nodes }) => produceRate / nodes)
export const latencyBudget = p99.add(q(5, u.ms))

// checked boundary for untyped input
export const fromCli = parseQuantity('5000 req/s').as(u.req.div(u.s))
