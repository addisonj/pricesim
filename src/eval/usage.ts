// Usage phase (DESIGN.md §8.1): walk the request graph, collect per-request contributions, integrate over
// the workload's time steps, size capacity for peak, and write a usage ledger. No prices here.
import type { Bindings } from '../core/expr.ts'
import { Expr, refersTo } from '../core/expr.ts'
import { combine, sameDim, showDim, UnitError } from '../core/dim.ts'
import { u } from '../core/units.ts'
import {
  InstancePool,
  NodePool,
  nodeCapacity,
  perNodeBills,
  PodGroup,
  podRequests,
  RESOURCES,
  customCapacities,
  type Resource,
  type ResourceName,
  type PoolUse,
  type Sink,
} from '../model/capacity.ts'
import type { GraphNode } from '../model/node.ts'
import { crossAzFactor } from '../model/request.ts'
import type { BillingDimension } from '../pricing/dimension.ts'
import { tenantsOf, type Scenario } from './scenario.ts'
import type { Workload } from '../workload/workload.ts'
import { isDist } from '../workload/dist.ts'
import { rng } from '../workload/random.ts'
import { meanRateBindings } from '../workload/workload.ts'
import { peakOf } from '../workload/peak.ts'
import { docs } from '../docs/registry.ts'

/** A path segment in the cost tree. */
export interface Seg {
  readonly name: string
  readonly kind:
    'service' | 'offering' | 'request' | 'gauges' | 'gauge' | 'pool' | 'idle' | 'network' | 'fixed' | 'tenant'
}

export interface LedgerEntry {
  readonly path: readonly Seg[]
  readonly dimension: BillingDimension
  /** usage over the modeled period, in base units of the dimension's usage unit */
  readonly usage: number
  /** 'idle': provisioned but unused capacity; 'fixed': time-based base charges */
  readonly kind: 'used' | 'idle' | 'fixed'
  /** the payer (see Scenario.account / node `account`) */
  readonly account: string
}

export interface ResourceStats {
  /** peak demand over the period (base units: millicore, byte, byte/s) */
  readonly peak: number
  /** mean demand over the period */
  readonly mean: number
  /** provisioned capacity (for pods: requested) */
  readonly capacity: number
}

export interface PoolReport {
  readonly name: string
  readonly kind: 'instances' | 'pods' | 'nodes'
  readonly instance?: string
  readonly nodePool?: string
  readonly count: number
  readonly min: number
  readonly binding: ResourceName | 'min' | 'maxPods'
  readonly resources: Partial<Record<ResourceName, ResourceStats>>
}

export interface UsageResult {
  readonly periodSeconds: number
  readonly steps: number
  readonly ledger: readonly LedgerEntry[]
  readonly pools: readonly PoolReport[]
}

/**
 * A symbolic contribution: usage of a billing dimension or demand on a capacity sink, per single root
 * request (rate-driven) or as a level (gauge-driven). `amount` is an expression over workload attributes,
 * params and gauge levels, so the same expansion serves numeric evaluation and closed forms.
 */
export type Contribution =
  | {
      readonly kind: 'bill'
      readonly path: readonly Seg[]
      readonly dimension: BillingDimension
      readonly amount: Expr<any>
      /** gauge-driven bills with a zero level are dropped (the dimension isn't billed at all) */
      readonly fromGauge?: boolean
      /** product of call multiplicities above this contribution; a zero prunes it */
      readonly mult?: Expr<{}>
      /** a modeling error that only matters if the contribution survives pruning */
      readonly error?: string
      /** the account (payer) whose bill this lands on */
      readonly account: string
    }
  | {
      readonly kind: 'use'
      readonly path: readonly Seg[]
      readonly sink: Sink
      readonly resource: ResourceName
      readonly amount: Expr<any>
      readonly mult?: Expr<{}>
      readonly account: string
    }

const MAX_DEPTH = 32
/** the payer when neither the scenario nor any node names one */
export const DEFAULT_ACCOUNT = 'provider'
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * Custom resources must be declared by the sink, in a matching unit: a per-request demand (use) against a
 * per-second capacity, a level (hold) against a capacity in the same unit.
 */
const checkCustom = (use: PoolUse, where: string) => {
  if ((RESOURCES as readonly string[]).includes(use.resource)) return
  const cap = use.sink.customCapacity(use.resource)
  if (!cap) throw new Error(`${where}: '${use.sink.name}' declares no custom resource '${use.resource}'`)
  const demandDim = use.level ? use.amount.dim : combine(use.amount.dim, { s: 1 }, -1)
  if (!sameDim(demandDim, cap.dim)) {
    throw new UnitError(
      `${where}: '${use.resource}' on '${use.sink.name}' has capacity in ${showDim(cap.dim)} but the ${
        use.level ? 'level' : 'per-request demand per second'
      } is ${showDim(demandDim)}`,
    )
  }
}
const MISSING_INTER_AZ: BillingDimension = {
  id: '(missing interAz)',
  usageUnit: u.byte,
  schedule: { kind: 'flat', rate: 0 },
  family: 'missing',
}
const ONE: Expr<{}> = new Expr<{}>({ k: 'const', v: 1 }, {})
const lift = (m: number | Expr<{}>): Expr<{}> => (typeof m === 'number' ? new Expr<{}>({ k: 'const', v: m }, {}) : m)
const isZero = (e: Expr<any>) => e.node.k === 'const' && e.node.v === 0
const times = (e: Expr<any>, m: Expr<{}>): Expr<any> => (m === ONE ? e : e.mul(m))

/** Expand one request into per-request contributions (amounts per single root request). */
const expandRequest = (
  node: GraphNode,
  reqName: string,
  attrs: Readonly<Record<string, Expr<any>>>,
  mult: Expr<{}>,
  path: readonly Seg[],
  scenario: Scenario,
  out: Contribution[],
  depth = 0,
  inherited: string = DEFAULT_ACCOUNT,
): void => {
  // a node's own account wins; otherwise it bills to its caller's account
  const account = node.account ?? inherited
  const push = (c: DistributiveOmit<Contribution, 'account'>): void => {
    out.push({ ...c, account } as Contribution)
  }
  if (depth > MAX_DEPTH) throw new Error(`request graph too deep (cycle?) at ${path.map((s) => s.name).join('/')}`)
  const def = node.requests[reqName]
  if (!def) throw new Error(`${node.name} has no request type '${reqName}'`)
  const r: Record<string, Expr<any>> = {}
  for (const [k, unit] of Object.entries(def.attrs)) {
    const v = attrs[k]
    if (v === undefined) throw new Error(`${node.name}.${reqName}: missing attribute '${k}'`)
    try {
      r[k] = v.as(unit)
    } catch (e) {
      throw new UnitError(`${node.name}.${reqName}: attribute '${k}': ${(e as Error).message}`)
    }
  }
  const body = def.body(r as never)
  const here = [...path, { name: reqName, kind: 'request' as const }]
  const m = mult === ONE ? {} : { mult }
  for (const use of body.use ?? []) {
    if (use.level) {
      throw new Error(
        `${node.name}.${reqName}: ${use.resource}() is a level demand; declare it in gaugeUse, not in a request`,
      )
    }
    checkCustom(use, `${node.name}.${reqName}`)
    push({ kind: 'use', path: here, sink: use.sink, resource: use.resource, amount: times(use.amount, mult), ...m })
  }
  for (const bl of body.bill ?? []) {
    push({ kind: 'bill', path: here, dimension: bl.dimension, amount: times(bl.usage, mult), ...m })
  }
  for (const e of body.net ?? []) {
    // network demand on the pools at either end (optional), independent of the AZ pattern
    for (const sink of [e.from, e.to]) {
      if (sink) push({ kind: 'use', path: here, sink, resource: 'network', amount: times(e.bytes, mult), ...m })
    }
    const f = crossAzFactor(e.pattern)
    if (f === 0) continue
    // cross-AZ transfer is charged on both the sending and the receiving side
    push({
      kind: 'bill',
      path: [...here, { name: 'cross-az', kind: 'network' }],
      dimension: scenario.interAz ?? MISSING_INTER_AZ,
      amount: times(e.bytes.mul(f * 2), mult),
      ...m,
      ...(scenario.interAz
        ? {}
        : { error: `${node.name}.${reqName} declares network edges but the scenario has no interAz dimension` }),
    })
  }
  for (const call of body.calls ?? []) {
    const m = lift(call.multiplicity)
    if (isZero(m)) continue
    const childPath = [...here, { name: call.node.name, kind: call.node.kind }]
    expandRequest(
      call.node,
      call.request,
      call.attrs,
      mult === ONE ? m : mult.mul(m),
      childPath,
      scenario,
      out,
      depth + 1,
      account,
    )
  }
}

/** Nodes reachable from `root` through dependencies, parents before children. */
const topoOrder = (root: GraphNode): GraphNode[] => {
  const seen = new Set<GraphNode>()
  const post: GraphNode[] = []
  const visit = (n: GraphNode, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error('dependency graph too deep (cycle?)')
    if (seen.has(n)) return
    seen.add(n)
    for (const d of Object.values(n.deps)) visit(d, depth + 1)
    post.push(n)
  }
  visit(root, 0)
  return post.reverse()
}

/**
 * Expand gauge levels into level contributions (billed as level × time, or memory demand).
 *
 * A node reached from several parents keeps one *source* per parent path: billing (linear) is attributed to
 * each parent's path, and mappings onward are propagated per source. Capacity demand (gaugeUse, possibly
 * non-linear, e.g. ceil) is computed once from the total across sources and attributed to the first path.
 */
const expandGauges = (
  root: GraphNode,
  rootLevels: Readonly<Record<string, Expr<any>>>,
  rootPath: readonly Seg[],
  out: Contribution[],
  rootAccount: string,
): void => {
  type Source = { path: readonly Seg[]; levels: Record<string, Expr<any>>; account: string }
  const sources = new Map<GraphNode, Source[]>()
  sources.set(root, [{ path: rootPath, levels: { ...rootLevels }, account: root.account ?? rootAccount }])
  const addSource = (node: GraphNode, path: readonly Seg[], gauge: string, value: Expr<any>, from: string) => {
    const list = sources.get(node) ?? []
    const key = pathKey(path)
    let src = list.find((s) => pathKey(s.path) === key)
    if (!src) {
      src = { path, levels: {}, account: node.account ?? from }
      list.push(src)
      sources.set(node, list)
    }
    const prev = src.levels[gauge]
    src.levels[gauge] = prev ? prev.add(value) : value
  }
  const zero = (def: { unit: { dim: Expr<any>['dim'] } }) => new Expr<any>({ k: 'const', v: 0 }, def.unit.dim)
  const exprsOf = (node: GraphNode, levels: Readonly<Record<string, Expr<any>>>) =>
    Object.fromEntries(Object.entries(node.gauges).map(([n, def]) => [n, (levels[n] ?? zero(def)).as(def.unit)]))

  for (const node of topoOrder(root)) {
    const srcs = sources.get(node)
    if (!srcs?.length) continue
    // billing and onward mappings, per source path
    for (const src of srcs) {
      const here = [...src.path, { name: 'gauges', kind: 'gauges' as const }]
      for (const [name, def] of Object.entries(node.gauges)) {
        const v = src.levels[name]
        if (def.billAs && v && !isZero(v)) {
          out.push({
            kind: 'bill',
            path: [...here, { name, kind: 'gauge' }],
            dimension: def.billAs,
            amount: v,
            fromGauge: true,
            account: src.account,
          })
        }
      }
      for (const m of node.gaugeMap?.(exprsOf(node, src.levels)) ?? []) {
        addSource(m.node, [...here, { name: m.node.name, kind: m.node.kind }], m.gauge, m.value, src.account)
      }
    }
    // capacity demand from the total across sources
    const total: Record<string, Expr<any>> = {}
    for (const src of srcs) {
      for (const [n, v] of Object.entries(src.levels)) total[n] = total[n] ? total[n].add(v) : v
    }
    const here = [...srcs[0]!.path, { name: 'gauges', kind: 'gauges' as const }]
    for (const use of node.gaugeUse?.(exprsOf(node, total)) ?? []) {
      checkCustom(use, `${node.name} gaugeUse`)
      // one line per held resource, so e.g. the cost of streams and of retained bytes can be read separately
      out.push({
        kind: 'use',
        path: [...here, { name: use.resource, kind: 'gauge' }],
        sink: use.sink,
        resource: use.resource,
        amount: use.amount,
        account: srcs[0]!.account,
      })
    }
  }
}

export interface Expansion {
  /** per root request type: contributions per single request */
  readonly requests: readonly { readonly name: string; readonly contribs: readonly Contribution[] }[]
  /** level contributions from the workload's gauges */
  readonly levels: readonly Contribution[]
}

/**
 * Symbolic expansion of a workload through the request and gauge graphs. `workload` defaults to the
 * scenario's single workload; `prefix` is prepended to every path (used for tenant attribution).
 */
export const expand = (scenario: Scenario, workload?: Workload, prefix: readonly Seg[] = []): Expansion => {
  const w = workload ?? scenario.workload
  if (!w) throw new Error('expand: multi-tenant scenario needs an explicit workload')
  const root = scenario.root.$node
  const rootPath: Seg[] = [...prefix, { name: root.name, kind: root.kind }]
  const requests: { name: string; contribs: Contribution[] }[] = []
  for (const [name, load] of Object.entries(w.requests)) {
    if (!load) continue
    const contribs: Contribution[] = []
    const dists = Object.entries(load.attrs).filter(([, v]) => isDist(v))
    if (!dists.length) {
      expandRequest(
        root,
        name,
        load.attrs as Record<string, Expr<any>>,
        ONE,
        rootPath,
        scenario,
        contribs,
        0,
        scenario.account ?? DEFAULT_ACCOUNT,
      )
    } else {
      // Monte Carlo over distribution-valued attributes: each sample carries 1/N of the requests
      const n = w.samples
      const r = rng(w.seed).fork(`${prefix.map((s) => s.name).join('/')}/${name}`)
      const share = lift(1 / n)
      for (let i = 0; i < n; i++) {
        const attrs = Object.fromEntries(
          Object.entries(load.attrs).map(([k, v]) => [
            k,
            isDist(v) ? new Expr<any>({ k: 'const', v: v.sample(r) }, v.dim) : (v as Expr<any>),
          ]),
        )
        expandRequest(root, name, attrs, share, rootPath, scenario, contribs, 0, scenario.account ?? DEFAULT_ACCOUNT)
      }
    }
    requests.push({ name, contribs })
  }
  const levels: Contribution[] = []
  expandGauges(root, w.gauges, rootPath, levels, scenario.account ?? DEFAULT_ACCOUNT)
  return { requests, levels }
}

type Numeric<C> = C extends unknown
  ? Omit<C, 'amount'> & { readonly amount: number; readonly at?: (t: number) => number }
  : never
type NumericContribution = Numeric<Contribution>

const bindNumeric = (cs: readonly Contribution[], b: Bindings): NumericContribution[] =>
  cs
    // calls whose multiplicity evaluates to 0 contribute nothing, not even zero-usage lines
    .filter((c) => !c.mult || c.mult.eval(b) !== 0)
    .map((c) => {
      if (c.kind === 'bill' && c.error) throw new Error(c.error)
      // levels that vary over the period (reference `time`) are evaluated at every step
      if (refersTo(c.amount.node, 'time')) {
        const e = c.amount
        return { ...c, amount: NaN, at: (t: number) => e.eval({ ...b, time: t }) } as NumericContribution
      }
      return { ...c, amount: c.amount.eval(b) } as NumericContribution
    })
    .filter((c) => !(c.kind === 'bill' && c.fromGauge && c.amount === 0))

const pathKey = (p: readonly Seg[]) => p.map((s) => `${s.kind}:${s.name}`).join('/')

interface SinkAcc {
  sink: Sink
  /** demand per step per resource (rate-driven + levels), base units */
  demand: Record<ResourceName, Float64Array>
  /** integrated demand (resource-seconds) per contributor path */
  byPath: Map<string, { path: readonly Seg[]; resource: ResourceName; resSeconds: number }>
}

export const collectUsage = (scenario: Scenario): UsageResult => {
  const tenants = tenantsOf(scenario)
  // period, step and peak definition come from the first tenant (tenantsOf checks they agree)
  const w = tenants[0]!.workload
  const root = scenario.root.$node
  const steps = Math.round(w.periodSeconds / w.stepSeconds)
  const dt = w.periodSeconds / steps
  // symbolic expansion per tenant, bound numerically with that tenant's params and mean rates
  const perRequest: { rateAt: (t: number) => number; contribs: NumericContribution[] }[] = []
  const levelContribs: NumericContribution[] = []
  for (const tenant of tenants) {
    const tw = tenant.workload
    const b: Bindings = { ...meanRateBindings(tw), ...tw.params }
    const prefix: Seg[] = tenant.id === undefined ? [] : [{ name: tenant.id, kind: 'tenant' }]
    const expansion = expand(scenario, tw, prefix)
    for (const { name, contribs } of expansion.requests) {
      const rate = tw.requests[name]!.rate
      perRequest.push({ rateAt: (t: number) => rate.at(t), contribs: bindNumeric(contribs, b) })
    }
    levelContribs.push(...bindNumeric(expansion.levels, b))
  }

  // integrate
  const billAcc = new Map<
    string,
    { path: readonly Seg[]; dimension: BillingDimension; usage: number; account: string }
  >()
  const sinks = new Map<Sink, SinkAcc>()
  const sinkAcc = (s: Sink): SinkAcc => {
    let a = sinks.get(s)
    if (!a) {
      a = {
        sink: s,
        demand: Object.fromEntries(RESOURCES.map((r) => [r, new Float64Array(steps)])) as SinkAcc['demand'],
        // custom resources get their arrays on first demand (see dem)
        byPath: new Map(),
      }
      sinks.set(s, a)
    }
    return a
  }
  const addBill = (path: readonly Seg[], dimension: BillingDimension, usage: number, account: string) => {
    const k = `${account}|${pathKey(path)}|${dimension.id}`
    const e = billAcc.get(k)
    if (e) e.usage += usage
    else billAcc.set(k, { path, dimension, usage, account })
  }
  /** demand per step for a resource, created on first use (custom resources) */
  const dem = (a: SinkAcc, r: ResourceName): Float64Array => (a.demand[r] ??= new Float64Array(steps))
  const addUse = (a: SinkAcc, path: readonly Seg[], resource: ResourceName, resSeconds: number) => {
    const k = `${pathKey(path)}|${resource}`
    const e = a.byPath.get(k)
    if (e) e.resSeconds += resSeconds
    else a.byPath.set(k, { path, resource, resSeconds })
  }

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt
    for (const { rateAt, contribs } of perRequest) {
      const rate = rateAt(t)
      if (rate === 0) continue
      for (const c of contribs) {
        if (c.kind === 'bill') addBill(c.path, c.dimension, rate * c.amount * dt, c.account)
        else {
          const a = sinkAcc(c.sink)
          // per-request cpu (millicore·s) × req/s = millicore; network bytes × req/s = byte/s
          dem(a, c.resource)[i]! += rate * c.amount
          addUse(a, c.path, c.resource, rate * c.amount * dt)
        }
      }
    }
    for (const c of levelContribs) {
      const amount = c.at ? c.at(t) : c.amount
      if (c.kind === 'bill') addBill(c.path, c.dimension, amount * dt, c.account)
      else {
        const a = sinkAcc(c.sink)
        dem(a, c.resource)[i]! += amount
        addUse(a, c.path, c.resource, amount * dt)
      }
    }
  }

  const ledger: LedgerEntry[] = [...billAcc.values()].map((e) => ({ ...e, kind: 'used' as const }))

  // capacities and pod requests may use params: bind them with the (first) workload's params
  const pb: Bindings = { ...meanRateBindings(w), ...w.params }

  // every pool reachable from the root is provisioned at least at its minimum, used or not; fixed charges
  // accrue for the whole period
  const T0 = w.periodSeconds
  const visited = new Set<GraphNode>()
  // pools and fixed charges bill to their owning node's account (inherited down the dependency graph)
  const sinkAccount = new Map<Sink, string>()
  const visit = (n: GraphNode, inherited: string) => {
    if (visited.has(n)) return
    visited.add(n)
    const account = n.account ?? inherited
    for (const s of Object.values(n.pools)) {
      sinkAcc(s)
      if (!sinkAccount.has(s)) sinkAccount.set(s, account)
    }
    for (const f of n.fixed) {
      ledger.push({
        account,
        path: [
          { name: 'fixed', kind: 'fixed' },
          { name: n.name, kind: n.kind },
        ],
        dimension: f.dimension,
        usage: f.count * T0,
        kind: 'fixed',
      })
    }
    for (const d of Object.values(n.deps)) visit(d, account)
  }
  visit(root, scenario.account ?? DEFAULT_ACCOUNT)
  const accountOf = (s: Sink) => sinkAccount.get(s) ?? scenario.account ?? DEFAULT_ACCOUNT
  const pools: PoolReport[] = []
  const T = w.periodSeconds
  const stats = (arr: Float64Array, capacity: number): ResourceStats => {
    let sum = 0
    for (const v of arr) sum += v
    return { peak: peakOf(arr, w.peak), mean: sum / arr.length, capacity }
  }

  const idlePath = (pool: string, what: string): Seg[] => [
    { name: 'idle', kind: 'idle' },
    { name: pool, kind: 'pool' },
    { name: what, kind: 'idle' },
  ]

  /** a sink with demand on a resource it has no capacity (or pod request) for */
  const checkDeclared = (a: SinkAcc, cap: Partial<Record<ResourceName, number>>, why: (r: ResourceName) => string) => {
    for (const r of Object.keys(a.demand)) {
      if (cap[r] || !a.demand[r]!.some((v) => v !== 0)) continue
      throw new Error(`${a.sink.kind === 'pods' ? 'pods' : 'pool'} '${a.sink.name}' has demand on ${r}, but ${why(r)}`)
    }
  }
  const declared = (cap: Partial<Record<ResourceName, number>>): ResourceName[] =>
    Object.keys(cap).filter((r) => cap[r] !== undefined)

  // ---- attribution by dominant share (DESIGN §6.2 step 5, §6.4)
  //
  // A contributor (request path, or gauge path) is charged for its *dominant share* of the pool: the largest,
  // over resources, of its resource-seconds / the pool's capacity-seconds of that resource. In instance- (or
  // node-) seconds that is max_r(resSeconds_r / perInstanceCapacity_r). Shares are scaled down if they add up
  // to more than what they are carved from, so used never exceeds provisioned; the remainder is idle.

  /** resource-seconds per contributor path */
  const contributors = (a: SinkAcc) => {
    const m = new Map<string, { path: readonly Seg[]; res: Partial<Record<ResourceName, number>> }>()
    for (const e of a.byPath.values()) {
      const k = pathKey(e.path)
      let c = m.get(k)
      if (!c) m.set(k, (c = { path: e.path, res: {} }))
      c.res[e.resource] = (c.res[e.resource] ?? 0) + e.resSeconds
    }
    return [...m.values()]
  }
  /** instance-seconds worth of resource-seconds: the dominant share of one instance's capacity */
  const dominant = (res: Partial<Record<ResourceName, number>>, cap: Partial<Record<ResourceName, number>>) => {
    let ns = 0
    // resources the capacity map doesn't cover (a pod's custom resources, at node level) don't count here
    for (const [r, v] of Object.entries(res) as [ResourceName, number][])
      if (v && cap[r]) ns = Math.max(ns, v / cap[r]!)
    return ns
  }
  /** factor that scales `parts` down to fit in `whole` (1 when they already fit) */
  const fit = (whole: number, parts: number) => (parts > whole ? whole / parts : 1)
  const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0)

  /** A slice of a pool's instance-seconds on the cost tree. */
  interface Slice {
    readonly path: readonly Seg[]
    readonly seconds: number
    readonly kind: 'used' | 'idle'
  }
  /**
   * Bill each slice on the pool's per-instance dimensions (usage per instance-second): instance-hours and,
   * with a volume, its storage/IOPS/throughput, so volumes are split between used and idle like the instances.
   */
  const allocate = (
    slices: readonly Slice[],
    bills: readonly { readonly dimension: BillingDimension; readonly perSecond: number }[],
    account: string,
  ) => {
    for (const sl of slices) {
      if (sl.kind === 'used' && sl.seconds === 0) continue
      for (const b of bills) {
        ledger.push({ path: sl.path, dimension: b.dimension, usage: sl.seconds * b.perSecond, kind: sl.kind, account })
      }
    }
  }

  // ---- instance pools: size on every declared resource at peak, attribute by dominant share
  for (const a of sinks.values()) {
    if (!(a.sink instanceof InstancePool)) continue
    const { instance, min, loadFactor, volumes } = a.sink.spec
    const cap: Partial<Record<ResourceName, number>> = {
      ...nodeCapacity(instance, pb, volumes),
      ...customCapacities(a.sink, pb),
    }
    checkDeclared(a, cap, (r) => `neither instance type ${instance.id} nor the pool declares ${r} capacity`)
    let need = 0
    let binding: PoolReport['binding'] = 'min'
    for (const r of declared(cap)) {
      const n = peakOf(dem(a, r), w.peak) / (cap[r]! * loadFactor)
      if (n > need) {
        need = n
        binding = r
      }
    }
    const count = Math.max(min, Math.ceil(need))
    if (count === min && Math.ceil(need) < min) binding = 'min'
    const total = count * T
    const users = contributors(a).map((c) => ({
      path: [...c.path, { name: a.sink.name, kind: 'pool' as const }],
      seconds: dominant(c.res, cap),
    }))
    const k = fit(total, sum(users.map((x) => x.seconds)))
    const used = users.map((x) => ({ ...x, seconds: x.seconds * k, kind: 'used' as const }))
    const headroom = total - sum(used.map((x) => x.seconds))
    allocate(
      [...used, { path: idlePath(a.sink.name, 'headroom'), seconds: headroom, kind: 'idle' }],
      perNodeBills(instance, pb, volumes),
      accountOf(a.sink),
    )
    pools.push({
      name: a.sink.name,
      kind: 'instances',
      instance: instance.id,
      count,
      min,
      binding,
      resources: Object.fromEntries(declared(cap).map((r) => [r, stats(dem(a, r), count * cap[r]!)])),
    })
  }

  // ---- pod groups: replicas from peak demand vs requests; node pools from summed requests
  const groupsByNodePool = new Map<
    NodePool,
    { acc: SinkAcc; replicas: number; req: Partial<Record<ResourceName, number>> }[]
  >()
  for (const a of sinks.values()) {
    if (!(a.sink instanceof PodGroup)) continue
    const { minReplicas, targetUtilization, on } = a.sink.spec
    const req = podRequests(a.sink, pb)
    checkDeclared(
      a,
      req,
      (r) => `the pod request declares no ${r} (pod requests: cpu, memory, optional network, custom resources)`,
    )
    let need = 0
    let binding: PoolReport['binding'] = 'min'
    for (const r of declared(req)) {
      const n = peakOf(dem(a, r), w.peak) / (req[r]! * targetUtilization)
      if (n > need) {
        need = n
        binding = r
      }
    }
    const replicas = Math.max(minReplicas, Math.ceil(need))
    if (Math.ceil(need) < minReplicas) binding = 'min'
    const list = groupsByNodePool.get(on) ?? []
    list.push({ acc: a, replicas, req })
    groupsByNodePool.set(on, list)
    pools.push({
      name: a.sink.name,
      kind: 'pods',
      nodePool: on.name,
      count: replicas,
      min: minReplicas,
      binding,
      resources: Object.fromEntries(declared(req).map((r) => [r, stats(dem(a, r), replicas * req[r]!)])),
    })
  }

  for (const [np, groups] of groupsByNodePool) {
    const { instance, min, reserved, maxPods, packingEfficiency, volumes } = np.spec
    const cap = nodeCapacity(instance, pb, volumes)
    const res: Partial<Record<Resource, number>> = { cpu: reserved.cpu.eval(pb), memory: reserved.memory.eval(pb) }
    // node pools are sized on cpu and memory, and on network when any pod group requests it
    const dims: Resource[] = [
      'cpu',
      'memory',
      ...(groups.some((g) => g.req.network !== undefined) ? ['network' as const] : []),
    ]
    const requested: Partial<Record<Resource, number>> = {}
    let podCount = 0
    for (const g of groups) {
      for (const r of dims) requested[r] = (requested[r] ?? 0) + g.replicas * (g.req[r] ?? 0)
      podCount += g.replicas
    }
    let need = Math.ceil(podCount / maxPods)
    let binding = 'maxPods' as PoolReport['binding']
    for (const r of dims) {
      const n = Math.ceil(requested[r]! / ((cap[r]! - (res[r] ?? 0)) * packingEfficiency))
      // resources win ties with maxPods so utilization is reported on a real dimension
      if (n > need || (n === need && binding === 'maxPods')) {
        need = n
        binding = r
      }
    }
    const nodes = Math.max(min, need)
    if (need < min) binding = 'min'
    // node-seconds: each pod group's requests (dominant share of node capacity) and the system reservation are
    // carved out of the pool; within a group, its contributors' usage is carved out of its requests
    const total = nodes * T
    const perGroup = groups.map((grp) => {
      const requestedNs = Math.max(
        0,
        ...declared(grp.req)
          .filter((r): r is Resource => (cap as Partial<Record<ResourceName, number>>)[r] !== undefined)
          .map((r) => (grp.replicas * grp.req[r]! * T) / cap[r]!),
      )
      const users = contributors(grp.acc).map((c) => ({
        path: [...c.path, { name: grp.acc.sink.name, kind: 'pool' as const }],
        seconds: dominant(c.res, cap),
      }))
      return { grp, requestedNs, users, fitUsers: fit(requestedNs, sum(users.map((x) => x.seconds))) }
    })
    const systemNs = Math.max(0, ...(['cpu', 'memory'] as const).map((r) => (nodes * res[r]! * T) / cap[r]!))
    const carved = sum(perGroup.map((x) => x.requestedNs)) + systemNs
    const k = fit(total, carved)
    const slices: Slice[] = []
    for (const { grp, requestedNs, users, fitUsers } of perGroup) {
      const used = users.map((x) => ({ ...x, seconds: x.seconds * fitUsers * k, kind: 'used' as const }))
      slices.push(...used, {
        path: idlePath(np.name, `pod headroom: ${grp.acc.sink.name}`),
        seconds: requestedNs * k - sum(used.map((x) => x.seconds)),
        kind: 'idle',
      })
    }
    slices.push(
      { path: idlePath(np.name, 'system overhead'), seconds: systemNs * k, kind: 'idle' },
      { path: idlePath(np.name, 'node slack'), seconds: total - carved * k, kind: 'idle' },
    )
    // a node pool bills to the account of the first pod group placed on it
    allocate(slices, perNodeBills(instance, pb, volumes), accountOf(groups[0]!.acc.sink))
    pools.push({
      name: np.name,
      kind: 'nodes',
      instance: instance.id,
      count: nodes,
      min,
      binding,
      resources: Object.fromEntries(
        dims.map((r) => [r, { peak: requested[r]!, mean: requested[r]!, capacity: nodes * cap[r]! }]),
      ),
    })
  }

  return { periodSeconds: T, steps, ledger, pools }
}

docs([
  {
    name: 'DEFAULT_ACCOUNT',
    kind: 'const',
    module: 'pricesim',
    summary: "`'provider'`: the payer when neither the scenario nor any node names an account.",
    seeAlso: ['scenario'],
  },
  {
    name: 'expand',
    kind: 'function',
    module: 'pricesim',
    summary:
      'Symbolic expansion of a workload through the request and gauge graphs: per-request and per-level contributions (bills and pool demand) with their tree paths.',
    signature: 'expand(s: Scenario, workload?: Workload, prefix?: Seg[]): Expansion',
    internal: true,
  },
  {
    name: 'collectUsage',
    kind: 'function',
    module: 'pricesim',
    summary: 'The usage phase of `evaluate`: the usage ledger (used, idle, fixed) and pool sizing, before pricing.',
    signature: 'collectUsage(s: Scenario): UsageResult',
    internal: true,
  },
])
