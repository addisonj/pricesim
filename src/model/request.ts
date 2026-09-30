// Request types, billing contributions, gauges and network edges (DESIGN.md §5.2, §6, §6.3).
import type { Mul, Same } from '../core/dim.ts'
import { Expr } from '../core/expr.ts'
import type { Unit } from '../core/units.ts'
import type { BillingDimension } from '../pricing/dimension.ts'
import type { PoolUse, Sink } from './capacity.ts'
import type { GraphNode } from './node.ts'
import { doc, docs } from '../docs/registry.ts'

export type AttrUnits = Readonly<Record<string, Unit<any>>>
export type AttrExprs<A extends AttrUnits> = { readonly [K in keyof A]: A[K] extends Unit<infer D> ? Expr<D> : never }

/** Usage of a billing dimension per request (or, for gauges, per level). */
export interface Bill {
  readonly dimension: BillingDimension
  readonly usage: Expr<any>
}

export const bill = <D, E>(dimension: BillingDimension<D>, usage: Expr<E> & Same<D, E>): Bill => ({ dimension, usage })

doc({
  name: 'bill',
  kind: 'function',
  module: 'pricesim/model',
  summary: "Usage of a billing dimension per request, for a request body's `bill` list.",
  signature: 'bill(dimension: BillingDimension<D>, usage: Expr<D>): Bill',
  params: [
    {
      name: 'dimension',
      type: 'BillingDimension<D>',
      doc: 'What is billed, e.g. a catalog dimension or one made with `dimension(…)`.',
    },
    {
      name: 'usage',
      type: 'Expr<D>',
      doc: "Usage per request, in the dimension's usage unit (checked at compile time), e.g. `q(1, u.req)` or `r.bytes`.",
    },
  ],
  returns: 'A `Bill`. Put it in the `bill` list of a request body.',
  guidance: `
- Usage is per single request of the request type it appears in; the engine multiplies it by the request rate and by the multiplicities of the calls above it, and integrates over the period.
- Tiers and free tiers apply to the monthly total of the dimension (per account), not per request.
- Gauge levels are billed with \`gauge(unit, { billAs })\`, not with \`bill\`.`,
  examples: [
    `import { dimension, q, u } from 'pricesim'
import { bill, offering, request } from 'pricesim/model'

const queueRequests = dimension('example.queue.requests', u.req, 0.4e-6)
const queueBytes = dimension('example.queue.bytes', u.GB, 0.01)

export const queue = offering('queue:jobs', {
  requests: () => ({
    send: request({ bytes: u.byte }, (r) => ({
      bill: [bill(queueRequests, q(1, u.req)), bill(queueBytes, r.bytes)],
    })),
  }),
})`,
  ],
  seeAlso: ['request', 'offering', 'dimension', 'gauge'],
  guide: 'services',
})

/** A call into a dependency's request type, with a multiplicity (calls per parent request). */
export class Call {
  constructor(
    readonly node: GraphNode,
    readonly request: string,
    readonly attrs: Readonly<Record<string, Expr<any>>>,
    readonly multiplicity: Expr<{}> | number = 1,
  ) {}

  /** Calls per parent request (can be fractional, e.g. 0.3 for "30% of requests"). */
  times(n: number | Expr<{}>): Call {
    const m = this.multiplicity
    const next = typeof m === 'number' && typeof n === 'number' ? m * n : toExpr(m).mul(toExpr(n))
    return new Call(this.node, this.request, this.attrs, next)
  }
}

doc({
  name: 'Call',
  kind: 'class',
  module: 'pricesim/model',
  summary:
    "A call into a dependency's request type, made with `deps.x.<request>(attrs)`, for a request body's `calls` list.",
  signature:
    'class Call { readonly node: GraphNode; readonly request: string; readonly attrs; readonly multiplicity; times(n: number | Expr<{}>): Call }',
  returns: '`times(n)` returns a new `Call` whose multiplicity is multiplied by `n`.',
  guidance: `
- Don't construct it: \`deps.files.put({ bytes: r.bytes })\` returns one.
- The multiplicity is calls per parent request (default 1). \`times\` can be fractional (\`.times(0.3)\` for 30% of requests), above 1 (fan-out), or a dimensionless \`Expr\` (e.g. a \`param\`). Everything the callee does is scaled by it.
- A multiplicity of 0 drops the call entirely, including errors it would raise (e.g. a missing \`interAz\`).`,
  examples: [
    `import { q, u } from 'pricesim'
import { request, service } from 'pricesim/model'
import { s3Bucket } from 'pricesim/aws'

const files = s3Bucket('files')

export const reader = service('reader', {
  deps: { files },
  requests: ({ deps }) => ({
    // 30% of reads miss the cache and go to S3
    read: request({ bytes: u.byte }, (r) => ({ calls: [deps.files.get({ bytes: r.bytes }).times(0.3)] })),
    // each batch writes 4 objects of 1 MB
    batch: request({}, () => ({ calls: [deps.files.put({ bytes: q(1, u.MB) }).times(4)] })),
  }),
})`,
  ],
  seeAlso: ['request', 'service'],
  guide: 'services',
})

const toExpr = (n: number | Expr<{}>): Expr<{}> => (typeof n === 'number' ? new Expr<{}>({ k: 'const', v: n }, {}) : n)

export type EdgePattern =
  /** clients spread uniformly over `azs` AZs talk to a service in the same `azs` AZs: (azs-1)/azs crosses */
  | { readonly kind: 'uniformClients'; readonly azs: number }
  /** replication to rf replicas in distinct AZs: rf-1 copies cross */
  | { readonly kind: 'replicate'; readonly rf: number }
  | { readonly kind: 'sameAz' }
  /** an explicit expected number of cross-AZ copies of the bytes (e.g. 2 committer copies in other AZs) */
  | { readonly kind: 'crossAz'; readonly copies: number }

doc({
  name: 'EdgePattern',
  kind: 'type',
  module: 'pricesim/model',
  summary: "How an edge's bytes cross availability zones; `crossAzFactor` turns it into a number of cross-AZ copies.",
  signature: `type EdgePattern =
  | { kind: 'uniformClients'; azs: number } // (azs − 1) / azs of the bytes cross
  | { kind: 'replicate'; rf: number }       // rf − 1 copies cross (replicas in distinct AZs)
  | { kind: 'sameAz' }                      // nothing crosses
  | { kind: 'crossAz'; copies: number }     // an explicit number of cross-AZ copies`,
  seeAlso: ['edge', 'crossAzFactor'],
  guide: 'services',
})

/** The capacity sinks at the ends of an edge; each gets the edge's bytes as network demand. */
export interface EdgeEnds {
  readonly from?: Sink
  readonly to?: Sink
}

export interface NetEdge extends EdgeEnds {
  readonly bytes: Expr<{ byte: 1 }>
  readonly pattern: EdgePattern
}

/**
 * `bytes` moved per request with a traffic pattern: billed as cross-AZ transfer (DESIGN §6.3), and, when
 * `from`/`to` are given, added as network demand (bytes per request) on those sinks. Each end gets the full
 * `bytes`, whether or not they cross AZs; the same sink at both ends gets it twice.
 */
export const edge = <E>(bytes: Expr<E> & Same<E, { byte: 1 }>, pattern: EdgePattern, ends: EdgeEnds = {}): NetEdge => ({
  bytes: bytes as unknown as Expr<{ byte: 1 }>,
  pattern,
  ...(ends.from ? { from: ends.from } : {}),
  ...(ends.to ? { to: ends.to } : {}),
})

doc({
  name: 'edge',
  kind: 'function',
  module: 'pricesim/model',
  summary:
    "Bytes moved per request with an AZ traffic pattern, for a request body's `net` list: billed as cross-AZ transfer, and optionally as network demand on pools.",
  signature: 'edge(bytes: Expr<byte>, pattern: EdgePattern, ends?: { from?: Sink; to?: Sink }): NetEdge',
  params: [
    { name: 'bytes', type: 'Expr<byte>', doc: 'Bytes moved per request.' },
    {
      name: 'pattern',
      type: 'EdgePattern',
      doc: "`{ kind: 'uniformClients', azs }`, `{ kind: 'replicate', rf }`, `{ kind: 'sameAz' }` or `{ kind: 'crossAz', copies }`.",
    },
    {
      name: 'ends.from',
      type: 'Sink',
      optional: true,
      doc: 'A pool or pod group that gets `bytes` per request as network demand.',
    },
    { name: 'ends.to', type: 'Sink', optional: true, doc: 'Likewise, for the receiving end.' },
  ],
  returns: 'A `NetEdge`. Put it in the `net` list of a request body.',
  guidance: `
- **Billing:** bytes × \`crossAzFactor(pattern)\` × 2 on the scenario's \`interAz\` dimension; the 2 is because AWS charges both the sending and the receiving side.
- The scenario must set \`interAz\` (e.g. \`interAz\` from \`pricesim/aws\`) when any edge crosses AZs, or evaluation throws. A \`sameAz\` edge bills nothing and needs no \`interAz\`.
- **Network demand:** each end given gets the full \`bytes\`, whatever the pattern; the same sink at both ends gets it twice. Without ends the edge adds no pool demand. Don't also call \`pool.network(…)\` for the same bytes, or they count twice.`,
  examples: [
    `import { q, u } from 'pricesim'
import { edge, instancePool, request, service } from 'pricesim/model'
import { ec2 } from 'pricesim/aws'

const brokers = instancePool('brokers', { instance: ec2['c7g.2xlarge'], min: 3, loadFactor: 0.7, azs: 3 })

export const log = service('log', {
  pools: { brokers },
  requests: ({ pools }) => ({
    append: request({ bytes: u.byte }, (r) => ({
      net: [
        // producers in 3 AZs send to the leader: 2/3 of the bytes cross
        edge(r.bytes, { kind: 'uniformClients', azs: 3 }, { to: pools.brokers }),
        // the leader copies to 2 followers in other AZs
        edge(r.bytes, { kind: 'replicate', rf: 3 }, { from: pools.brokers }),
      ],
    })),
  }),
})`,
  ],
  seeAlso: ['EdgePattern', 'crossAzFactor', 'interAz', 'request'],
  guide: 'services',
})

export const crossAzFactor = (p: EdgePattern): number =>
  p.kind === 'uniformClients'
    ? (p.azs - 1) / p.azs
    : p.kind === 'replicate'
      ? p.rf - 1
      : p.kind === 'crossAz'
        ? p.copies
        : 0

doc({
  name: 'crossAzFactor',
  kind: 'function',
  module: 'pricesim/model',
  summary: "The number of cross-AZ copies of an edge's bytes for a pattern (one direction).",
  signature: 'crossAzFactor(pattern: EdgePattern): number',
  returns:
    '`uniformClients`: (azs − 1) / azs; `replicate`: rf − 1; `crossAz`: copies; `sameAz`: 0. The engine bills bytes × this × 2 (sender and receiver).',
  seeAlso: ['edge', 'EdgePattern'],
  guide: 'services',
})

export interface RequestBody {
  readonly use?: readonly PoolUse[]
  readonly calls?: readonly Call[]
  readonly bill?: readonly Bill[]
  readonly net?: readonly NetEdge[]
}

export interface RequestDef<A extends AttrUnits = AttrUnits> {
  readonly attrs: A
  readonly body: (r: AttrExprs<A>) => RequestBody
}

export const request = <A extends AttrUnits>(attrs: A, body: (r: AttrExprs<A>) => RequestBody): RequestDef<A> => ({
  attrs,
  body,
})

doc({
  name: 'request',
  kind: 'function',
  module: 'pricesim/model',
  summary: 'A request type of a service or offering: typed attributes and a body saying what one request costs.',
  signature: 'request(attrs: Record<string, Unit>, body: (r: attribute Exprs) => RequestBody): RequestDef',
  params: [
    {
      name: 'attrs',
      type: 'Record<string, Unit>',
      doc: 'Attribute names and units, e.g. `{ bytes: u.byte }`; `{}` for none. Callers must pass each one.',
    },
    {
      name: 'body',
      type: '(r) => RequestBody',
      doc: 'Receives the attributes as `Expr`s (`r.bytes: Expr<byte>`) and returns what one request does.',
    },
    {
      name: 'body → use',
      type: 'PoolUse[]',
      optional: true,
      doc: 'Per-request demand on pools: `pools.x.cpu(…)`, `.network(…)`, `.ebsIops(…)`, `.use(…)`.',
    },
    {
      name: 'body → calls',
      type: 'Call[]',
      optional: true,
      doc: 'Calls into dependencies: `deps.y.put({ bytes })`, optionally `.times(n)`.',
    },
    {
      name: 'body → bill',
      type: 'Bill[]',
      optional: true,
      doc: 'Direct usage of billing dimensions: `bill(dimension, usage)`.',
    },
    {
      name: 'body → net',
      type: 'NetEdge[]',
      optional: true,
      doc: 'Network edges, billed as cross-AZ transfer: `edge(bytes, pattern)`.',
    },
  ],
  returns:
    "A `RequestDef`. Return it from a node's `requests` function under the request type's name; callers then call it as `node.<name>(attrs)`.",
  guidance: `
- Everything in the body is **per single request**; the engine multiplies by the rate (and call multiplicities) and integrates over the period.
- Attributes are checked where one node calls another: the wrong dimension is a compile error, and values are converted to the declared unit at evaluation (a mismatch throws a \`UnitError\`, a missing attribute throws).
- The body builds expressions: it runs when the model is expanded, not once per request, so \`r.bytes\` holds no number yet. Use \`Expr\` operations (\`max\`, \`ceil\`, …) instead of \`if\` on attribute values.
- Level demands (\`memory\`, \`disk\`, \`hold\`) in \`use\` throw; put them in \`gaugeUse\`.
- \`gauges\` and \`$node\` can't be request type names.`,
  examples: [
    `import { q, u } from 'pricesim'
import { instancePool, request, service } from 'pricesim/model'
import { ec2 } from 'pricesim/aws'

const coreMs = u.vCPU.mul(u.ms)
const nodes = instancePool('api-nodes', { instance: ec2['c7g.xlarge'], min: 2, loadFactor: 0.7, azs: 2 })

export const api = service('api', {
  pools: { nodes },
  requests: ({ pools }) => ({
    // 3 core·ms fixed + 2 core·ms per MB received; the bytes also cross the NIC
    upload: request({ bytes: u.byte }, (r) => ({
      use: [pools.nodes.cpu(q(3, coreMs).add(r.bytes.mul(q(2, coreMs.div(u.MB))))), pools.nodes.network(r.bytes)],
    })),
  }),
})`,
  ],
  seeAlso: ['service', 'bill', 'edge', 'Call', 'Sink'],
  guide: 'services',
})

/** A point-in-time quantity (bytes retained, stream count, …); optionally billed as level × time. */
export interface GaugeDef<D = any> {
  readonly unit: Unit<D>
  readonly billAs?: BillingDimension
}

export const gauge = <D, B = Mul<D, { s: 1 }>>(
  unit: Unit<D>,
  opts: { billAs?: BillingDimension<B> & Same<B, Mul<D, { s: 1 }>> } = {},
): GaugeDef<D> => ({ unit, ...(opts.billAs ? { billAs: opts.billAs as BillingDimension } : {}) })

doc({
  name: 'gauge',
  kind: 'function',
  module: 'pricesim/model',
  summary: 'A point-in-time level of a node (bytes stored, open streams, …), optionally billed as level × time.',
  signature: 'gauge(unit: Unit<D>, opts?: { billAs?: BillingDimension<D·s> }): GaugeDef',
  params: [
    { name: 'unit', type: 'Unit<D>', doc: 'Unit of the level, e.g. `u.byte`, `u.count`, or a `baseUnit` of your own.' },
    {
      name: 'opts.billAs',
      type: 'BillingDimension<D·s>',
      optional: true,
      doc: 'Bill the level integrated over time on this dimension; its usage unit must be `unit` × time (e.g. `u.GB.mul(u.month)` for bytes), checked at compile time.',
    },
  ],
  returns:
    "A `GaugeDef`. Put it in a node's `gauges`; the node's `gaugeUse` and `gaugeMap` receive its level as an `Expr`, and callers set it with `node.gauges.<name>(value)`.",
  guidance: `
- A root node's levels come from the workload's \`gauges\`; a dependency's come only from its callers' \`gaugeMap\`. A level nobody sets is 0.
- A gauge can be billed (\`billAs\`), drive level demand on pools (\`gaugeUse\`), and map onto dependency gauges (\`gaugeMap\`), in any combination.
- A zero level isn't billed at all (no zero-usage line).`,
  examples: [
    `import { dimension, u } from 'pricesim'
import { gauge, offering } from 'pricesim/model'

const storage = dimension('example.store.storage', u.GB.mul(u.month), 0.023)

export const store = offering('store', {
  gauges: { stored: gauge(u.byte, { billAs: storage }) },
  requests: () => ({}),
})`,
  ],
  seeAlso: ['service', 'baseUnit', 'dimension'],
  guide: 'services',
})

/**
 * A charge that accrues per unit of time regardless of load, on a time-billed dimension (usage unit is a
 * time, e.g. hours): `count` units run for the whole period.
 */
export interface FixedCharge {
  readonly dimension: BillingDimension
  readonly count: number
}

export const fixedCharge = (dimension: BillingDimension<{ s: 1 }>, count = 1): FixedCharge => {
  const d = dimension.usageUnit.dim
  if (d.s !== 1 || Object.keys(d).length !== 1) {
    throw new Error(`fixedCharge: '${dimension.id}' must be billed per unit of time (e.g. hours)`)
  }
  return { dimension, count }
}

doc({
  name: 'fixedCharge',
  kind: 'function',
  module: 'pricesim/model',
  summary:
    'A time-based charge that accrues for the whole period regardless of load (load balancer hours, cluster fees, …).',
  signature: 'fixedCharge(dimension: BillingDimension<s>, count = 1): FixedCharge',
  params: [
    { name: 'dimension', type: 'BillingDimension<s>', doc: 'A dimension billed per unit of time, e.g. per hour.' },
    {
      name: 'count',
      type: 'number',
      optional: true,
      default: '1',
      doc: 'Units running for the whole period (e.g. 2 load balancers).',
    },
  ],
  returns: "A `FixedCharge`. Put it in a node's `fixed` list.",
  guidance: `
- Bills \`count\` × the period on \`dimension\`, under \`fixed\` in the cost tree, for every node reachable from the scenario's root (once per node, even if several services depend on it).
- Throws unless the dimension's usage unit is exactly a time.
- In tenant runs, fixed cost is shared out in proportion to used cost.`,
  examples: [
    `import { dimension, u } from 'pricesim'
import { fixedCharge, request, service } from 'pricesim/model'

const clusterHours = dimension('example.eks.cluster-hours', u.hour, 0.1)

export const platform = service('platform', {
  fixed: [fixedCharge(clusterHours)],
  requests: () => ({ ping: request({}, () => ({})) }),
})`,
  ],
  seeAlso: ['service', 'dimension'],
  guide: 'services',
})

export interface GaugeMapping {
  readonly node: GraphNode
  readonly gauge: string
  readonly value: Expr<any>
}
