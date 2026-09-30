// Graph nodes: offerings (leaf cloud products) and services. Both expose request types and gauges with
// the same shape, so they nest to any depth (DESIGN.md §2, §6).
import type { Expr } from '../core/expr.ts'
import type { Hardware, PoolUse, Sink } from './capacity.ts'
import { Call, type AttrExprs, type FixedCharge, type GaugeDef, type GaugeMapping, type RequestDef } from './request.ts'
import { doc, type ParamDoc } from '../docs/registry.ts'

export type GaugeExprs<G extends Record<string, GaugeDef>> = {
  readonly [K in keyof G]: G[K] extends GaugeDef<infer D> ? Expr<D> : never
}

export interface GraphNode {
  readonly name: string
  readonly kind: 'service' | 'offering'
  readonly requests: Readonly<Record<string, RequestDef>>
  readonly gauges: Readonly<Record<string, GaugeDef>>
  readonly gaugeUse?: (g: Record<string, Expr<any>>) => readonly PoolUse[]
  readonly gaugeMap?: (g: Record<string, Expr<any>>) => readonly GaugeMapping[]
  /** capacity this node owns; provisioned at least at its minimum size whether or not it is used */
  readonly pools: Readonly<Record<string, Sink>>
  readonly deps: Readonly<Record<string, GraphNode>>
  /** time-based charges that accrue whether or not the node is used (load balancers, cluster fees, …) */
  readonly fixed: readonly FixedCharge[]
  /** whose bill this node's charges land on; unset = its caller's account */
  readonly account?: string
}

/** How callers see a node: one function per request type, plus gauge mappers. */
export type Callable<R extends Record<string, RequestDef<any>>, G extends Record<string, GaugeDef>> = {
  readonly [K in keyof R]: (attrs: AttrExprs<R[K]['attrs']>) => Call
} & {
  readonly gauges: { readonly [K in keyof G]: (value: GaugeExprs<G>[K]) => GaugeMapping }
  readonly $node: GraphNode
}

/** Structural shape used in generic constraints (never route `any` through the invariant Expr<D>). */
export type AnyCallable = {
  readonly gauges: Readonly<Record<string, (value: any) => GaugeMapping>>
  readonly $node: GraphNode
}

export interface NodeCtx<Deps, Pools> {
  readonly deps: Deps
  readonly pools: Pools
}

const RESERVED = new Set(['gauges', '$node'])

const makeCallable = <R extends Record<string, RequestDef<any>>, G extends Record<string, GaugeDef>>(
  node: GraphNode,
): Callable<R, G> => {
  const out: Record<string, unknown> = { $node: node }
  for (const name of Object.keys(node.requests)) {
    if (RESERVED.has(name)) throw new Error(`${node.name}: request type name '${name}' is reserved`)
    out[name] = (attrs: Record<string, Expr<any>>) => new Call(node, name, attrs)
  }
  out.gauges = Object.fromEntries(
    Object.keys(node.gauges).map((g) => [g, (value: Expr<any>): GaugeMapping => ({ node, gauge: g, value })]),
  )
  return out as Callable<R, G>
}

export interface NodeDef<
  Deps extends Record<string, AnyCallable>,
  Pools extends Record<string, Sink>,
  G extends Record<string, GaugeDef>,
  R extends Record<string, RequestDef<any>>,
> {
  readonly deps?: Deps
  readonly pools?: Pools
  readonly gauges?: G
  /** request types are a function of the context so deps/pools are fully typed */
  readonly requests: (ctx: NodeCtx<Deps, Pools>) => R
  /** level demands (memory) driven by gauges */
  readonly gaugeUse?: (g: GaugeExprs<G>, ctx: NodeCtx<Deps, Pools>) => readonly PoolUse[]
  /** map this node's gauges onto dependency gauges */
  readonly gaugeMap?: (g: GaugeExprs<G>, ctx: NodeCtx<Deps, Pools>) => readonly GaugeMapping[]
  /** time-based base charges, e.g. `fixedCharge(albHours)` */
  readonly fixed?: readonly FixedCharge[]
  /**
   * Software capacity per instance (per pod) of this service's pools, derived from their hardware — e.g.
   * `{ nodes: (hw) => ({ partitions: hw.cpu.mul(q(3, partition.div(u.vCPU))), ops: q(1e6, u.op.div(u.s)) }) }`.
   * Requests demand it with `pool.use(name, …)`, gauges with `pool.hold(name, …)`.
   */
  readonly capacity?: { readonly [K in keyof Pools]?: (hw: Hardware) => Readonly<Record<string, Expr<any>>> }
  /**
   * Whose bill this node's charges land on (e.g. 'customer' for resources in the customer's AWS account). Its
   * dependencies inherit it unless they set their own. Unset: the caller's account.
   */
  readonly account?: string
}

const define =
  (kind: GraphNode['kind']) =>
  <
    Deps extends Record<string, AnyCallable> = {},
    Pools extends Record<string, Sink> = {},
    G extends Record<string, GaugeDef> = {},
    R extends Record<string, RequestDef<any>> = {},
  >(
    name: string,
    def: NodeDef<Deps, Pools, G, R>,
  ): Callable<R, G> => {
    const ctx: NodeCtx<Deps, Pools> = { deps: (def.deps ?? {}) as Deps, pools: (def.pools ?? {}) as Pools }
    for (const [key, derive] of Object.entries(def.capacity ?? {}) as [
      string,
      (hw: Hardware) => Record<string, Expr<any>>,
    ][]) {
      const pool = (def.pools as Record<string, Sink> | undefined)?.[key]
      if (!pool) throw new Error(`${name}: capacity for unknown pool '${key}'`)
      pool.declareCapacity(name, derive(pool.hardware()))
    }
    const node: GraphNode = {
      name,
      kind,
      requests: def.requests(ctx),
      gauges: def.gauges ?? {},
      pools: def.pools ?? {},
      deps: Object.fromEntries(Object.entries(def.deps ?? {}).map(([k, d]) => [k, d.$node])),
      fixed: def.fixed ?? [],
      ...(def.account ? { account: def.account } : {}),
      ...(def.gaugeUse ? { gaugeUse: (g) => def.gaugeUse!(g as GaugeExprs<G>, ctx) } : {}),
      ...(def.gaugeMap ? { gaugeMap: (g) => def.gaugeMap!(g as GaugeExprs<G>, ctx) } : {}),
    }
    return makeCallable<R, G>(node)
  }

/** A service: consumes pools, offerings and other services. */
export const service = define('service')
/** An offering: a priced cloud product (leaf of the cost tree), possibly with its own provisioned pool. */
export const offering = define('offering')

/** The NodeDef fields, shared by `service` and `offering`. */
const nodeDefParams: readonly ParamDoc[] = [
  {
    name: 'name',
    type: 'string',
    doc: 'Shown in the cost tree. Catalog offerings prefix it with the product, e.g. `s3:files`.',
  },
  {
    name: 'def.deps',
    type: 'Record<string, service | offering>',
    optional: true,
    doc: 'Nodes this one calls or maps gauges onto, by local name. `requests`, `gaugeUse` and `gaugeMap` see them fully typed as `deps.<name>`. The graph must be acyclic.',
  },
  {
    name: 'def.pools',
    type: 'Record<string, InstancePool | PodGroup>',
    optional: true,
    doc: 'Capacity this node owns, by local name, seen as `pools.<name>`. Every pool of every node reachable from the root is provisioned at least at its minimum, used or not.',
  },
  {
    name: 'def.gauges',
    type: 'Record<string, GaugeDef>',
    optional: true,
    doc: "Levels this node keeps, made with `gauge(unit, { billAs? })`. The root's are set by the workload; a dependency's by its callers' `gaugeMap`.",
  },
  {
    name: 'def.requests',
    type: '({ deps, pools }) => Record<string, RequestDef>',
    doc: 'The request types, each made with `request(attrs, body)`. `gauges` and `$node` are reserved names.',
  },
  {
    name: 'def.gaugeUse',
    type: '(g, { deps, pools }) => PoolUse[]',
    optional: true,
    doc: 'Level demand from the gauge levels `g` (typed `Expr`s): `pools.x.memory(…)`, `.disk(…)`, `.hold(name, …)`. Computed once from the total level across all callers.',
  },
  {
    name: 'def.gaugeMap',
    type: '(g, { deps, pools }) => GaugeMapping[]',
    optional: true,
    doc: "Levels for dependency gauges from this node's levels: `deps.files.gauges.stored(g.files.mul(…))`. Values mapped by several callers add up.",
  },
  {
    name: 'def.fixed',
    type: 'FixedCharge[]',
    optional: true,
    doc: 'Charges for the whole period regardless of load, made with `fixedCharge(dimension, count)`.',
  },
  {
    name: 'def.capacity',
    type: '{ [pool]?: (hw: Hardware) => Record<string, Expr> }',
    optional: true,
    doc: "Custom (software) capacity per instance or pod of this node's pools, derived from the pool's hardware, e.g. partitions per core. Keys must be keys of `pools`.",
  },
  {
    name: 'def.account',
    type: 'string',
    optional: true,
    default: "the caller's account",
    doc: "Whose bill this node's charges land on (e.g. `'customer'`): its bills, pools and fixed charges. Dependencies inherit it unless they set their own.",
  },
]

const nodeReturns =
  "A callable node: `node.<request>(attrs)` returns a `Call` for a caller's `calls`, `node.gauges.<gauge>(value)` a mapping for a caller's `gaugeMap`, and `node.$node` the runtime node. Pass it in another node's `deps`, or as a scenario's `root`."

doc({
  name: 'service',
  kind: 'function',
  module: 'pricesim/model',
  summary:
    'A service: a node of the cost graph with request types, and optionally its own capacity, gauges and dependencies.',
  signature: 'service(name: string, def: NodeDef): Callable',
  params: nodeDefParams,
  returns: nodeReturns,
  guidance: `
- **Shape:** \`requests\` (and \`gaugeUse\`, \`gaugeMap\`) are functions of \`{ deps, pools }\`, so calls, attributes and pool demands are type-checked.
- **Rates vs levels:** per-request demand (\`cpu\`, \`network\`, \`ebsBandwidth\`, \`ebsIops\`, \`use\`) goes in request bodies; level demand (\`memory\`, \`disk\`, \`hold\`) goes in \`gaugeUse\`. A level demand in a request throws at evaluation. Gauge-driven cost appears under \`gauges\` in the cost tree, not under a request.
- **Minimums dominate small workloads:** every pool of every reachable node is provisioned at its minimum and every fixed charge accrues, even if no request uses them.
- **gaugeUse on totals:** when several callers map onto this node's gauges, \`gaugeUse\` sees the summed level (so a \`ceil\` in it applies once), while \`billAs\` billing is split per caller path.
- **Custom capacity (\`capacity\`):** runs once when the service is defined. A name can't be a built-in resource (\`cpu\`, \`disk\`, …), and only one service may declare a given name on a pool; both throw, as does a key that isn't in \`pools\`. Demand it per request with \`pool.use(name, perRequest)\` (capacity in the per-request unit per second) or as a level with \`pool.hold(name, level)\` (capacity in the level's unit). For pods, \`hw\` is the pod's request, not the node.
- **Accounts:** \`account\` sets the payer for this node and, unless they set their own, its dependencies. Tiers are applied per account.
- \`service\` and \`offering\` take the same definition and behave the same; the difference is the label in the cost tree.`,
  examples: [
    `import { q, u } from 'pricesim'
import { edge, gauge, instancePool, request, service } from 'pricesim/model'
import { applicationLoadBalancer, ec2, s3Bucket } from 'pricesim/aws'

const coreMs = u.vCPU.mul(u.ms)
const lb = applicationLoadBalancer('uploads')
const files = s3Bucket('files')

export const uploads = service('uploads', {
  deps: { lb, files },
  pools: { api: instancePool('uploads-api', { instance: ec2['c7g.xlarge'], min: 2, loadFactor: 0.6, azs: 3 }) },
  gauges: { files: gauge(u.count) },
  requests: ({ deps, pools }) => ({
    upload: request({ bytes: u.byte }, (r) => ({
      use: [pools.api.cpu(q(3, coreMs))],
      calls: [deps.lb.forward({ bytes: r.bytes }), deps.files.put({ bytes: r.bytes })],
      net: [edge(r.bytes, { kind: 'uniformClients', azs: 3 })],
    })),
    download: request({ bytes: u.byte }, (r) => ({
      use: [pools.api.cpu(q(1, coreMs))],
      calls: [deps.lb.forward({ bytes: r.bytes }), deps.files.get({ bytes: r.bytes })],
    })),
  }),
  // every file kept is ~500 KB in S3
  gaugeMap: (g, { deps }) => [deps.files.gauges.stored(g.files.mul(q(500, u.KB.div(u.count))))],
})`,
    `import { baseUnit, q, u } from 'pricesim'
import { gauge, instancePool, request, service } from 'pricesim/model'
import { ec2 } from 'pricesim/aws'

const stream = baseUnit('stream')
const partition = baseUnit('partition')
const nodes = instancePool('store-nodes', { instance: ec2['c7g.2xlarge'], min: 3, loadFactor: 0.7, azs: 3 })

export const store = service('store', {
  pools: { nodes },
  // software limits per node: 3 partitions per core, 10k streams per partition, 1M appends/s
  capacity: {
    nodes: (hw) => ({
      streams: hw.cpu.mul(q(3, partition.div(u.vCPU))).mul(q(10_000, stream.div(partition))),
      appends: q(1e6, u.op.div(u.s)),
    }),
  },
  gauges: { streams: gauge(stream) },
  requests: ({ pools }) => ({
    append: request({}, () => ({ use: [pools.nodes.use('appends', q(1, u.op))] })),
  }),
  gaugeUse: (g, { pools }) => [pools.nodes.hold('streams', g.streams)],
})`,
  ],
  seeAlso: ['offering', 'request', 'gauge', 'instancePool', 'pods', 'fixedCharge', 'edge'],
  guide: 'services',
})

doc({
  name: 'offering',
  kind: 'function',
  module: 'pricesim/model',
  summary:
    'An offering: a priced cloud product, usually a leaf of the cost tree (it may own a pool, e.g. Aurora instances).',
  signature: 'offering(name: string, def: NodeDef): Callable',
  params: nodeDefParams,
  returns: nodeReturns,
  guidance: `
- Takes the same definition as \`service\` and behaves the same; only the label in the cost tree differs. Use it for products you pay a provider for (a queue, a bucket, a load balancer), and \`service\` for your own software.
- The catalog (\`pricesim/aws\`) has ready-made offerings (\`s3Bucket\`, \`applicationLoadBalancer\`, \`auroraPostgres\`, …); write one when a product is missing.
- Typical parts: \`bill(…)\` per request, gauges with \`billAs\` for storage, \`fixed\` for hourly charges.`,
  examples: [
    `import { dimension, freeTier, q, u } from 'pricesim'
import { bill, fixedCharge, gauge, offering, request } from 'pricesim/model'

const requests = dimension('example.queue.requests', u.req, freeTier(1e6, 0.4e-6))
const storage = dimension('example.queue.storage', u.GB.mul(u.month), 0.1)
const hours = dimension('example.queue.hours', u.hour, 0.05)

export const queue = offering('queue:jobs', {
  gauges: { backlog: gauge(u.byte, { billAs: storage }) },
  fixed: [fixedCharge(hours)],
  requests: () => ({
    send: request({}, () => ({ bill: [bill(requests, q(1, u.req))] })),
  }),
})`,
  ],
  seeAlso: ['service', 'bill', 'gauge', 'fixedCharge', 'dimension'],
  guide: 'services',
})
