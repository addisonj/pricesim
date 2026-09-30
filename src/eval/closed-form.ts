// Closed-form cost (DESIGN.md §4, §8.1): total monthly cost as an expression over kept symbols (request
// rates, request attributes, gauge levels, params), simplified with mathjs.
//
// Built from the symbolic expansion (usage.ts `expand`) and priced at the operating point: each billing
// dimension uses its effective rate from a numeric evaluation (tiers, discounts, region multiplier), so tiers
// never enter the algebra. Capacity is sized from peak rates, assuming request peaks coincide.
//
// Modes:
//   exact   — keeps ceil() and max(min, …) per pool and max over resource dimensions; at the operating point it
//             equals `evaluate(s).total` when peaks coincide
//   relaxed — continuous: drops ceil and minimum sizes, and sizes each pool on its binding dimension at the
//             operating point, so the result is linear in the rates
import { simplify } from 'mathjs'
import { Expr, refersTo, type Bindings, type Node } from '../core/expr.ts'
import { MONTH_SECONDS } from '../core/units.ts'
import {
  InstancePool,
  NodePool,
  nodeCapacity,
  perNodeBills,
  PodGroup,
  podRequests,
  customCapacities,
  type ResourceName,
  type Resource,
  type Sink,
} from '../model/capacity.ts'
import type { GraphNode } from '../model/node.ts'
import type { BillingDimension } from '../pricing/dimension.ts'
import { meanRateBindings, type Workload } from '../workload/workload.ts'
import { isDist } from '../workload/dist.ts'
import { peakOf } from '../workload/peak.ts'
import { evaluate } from './evaluate.ts'
import { singleWorkload, withWorkload, type Scenario } from './scenario.ts'
import { expand } from './usage.ts'
import { doc } from '../docs/registry.ts'

export interface ClosedFormOptions {
  readonly mode?: 'exact' | 'relaxed'
  /**
   * Symbols to keep symbolic; everything else is bound to its scenario value. Names:
   * `rate.<request>` (mean req/s), `<request>.<attr>`, `gauge.<name>`, or a param name.
   * Default: every request rate.
   */
  readonly keep?: readonly string[]
}

export interface ClosedFormSymbol {
  readonly name: string
  /** identifier used in `expression` */
  readonly id: string
  /** scenario value, in base units */
  readonly value: number
  readonly unit: string
  readonly kept: boolean
}

export interface ClosedForm {
  readonly quantity: 'total'
  readonly unit: 'USD/month'
  readonly mode: 'exact' | 'relaxed'
  /** simplified expression over the kept symbols (base units: req/s, byte, …) */
  readonly expression: string
  /** the expression evaluated at the scenario's values */
  readonly value: number
  /** `evaluate(s).total` for comparison */
  readonly numericTotal: number
  readonly symbols: readonly ClosedFormSymbol[]
  /**
   * When the expression is linear in the kept symbols: `total = constant + Σ perUnit[id] × id` (base units,
   * e.g. USD/month per req/s). Always linear in relaxed mode unless attributes enter through ceil().
   */
  readonly linear?: { readonly constant: number; readonly perUnit: Readonly<Record<string, number>> }
  readonly assumptions: readonly string[]
}

// ---------- raw AST helpers (dimensions were checked when the model was built) ----------
const c = (v: number): Node => ({ k: 'const', v })
const mul = (...xs: Node[]): Node => xs.reduce((a, b) => ({ k: 'bin', op: '*', a, b }))
const add = (all: Node[]): Node => {
  const xs = all.filter((x) => !isZeroNode(x))
  return xs.length ? xs.reduce((a, b) => ({ k: 'bin', op: '+', a, b })) : c(0)
}
const div = (a: Node, b: Node): Node => ({ k: 'bin', op: '/', a, b })
const fmax = (...all: Node[]): Node => {
  // ceil(0) terms from resources nothing uses don't change a max over non-negative sizes
  const args = all.filter((a, i) => i === 0 || !(a.k === 'fn' && a.name === 'ceil' && isZeroNode(a.args[0]!)))
  return args.length === 1 ? args[0]! : { k: 'fn', name: 'max', args }
}
const fceil = (a: Node): Node => ({ k: 'fn', name: 'ceil', args: [a] })
const evalN = (n: Node, b: Bindings) => new Expr<any>(n, {}).eval(b)

/** 6 significant digits, no exponent noise for ordinary magnitudes */
const fmtNum = (v: number): string => {
  if (v === 0) return '0'
  const r = Number(v.toPrecision(6))
  return Math.abs(r) >= 1e-4 && Math.abs(r) < 1e9 ? String(r) : r.toExponential()
}

/** structurally zero: a zero constant, or a product/quotient with a zero numerator/factor */
const isZeroNode = (n: Node): boolean =>
  (n.k === 'const' && n.v === 0) ||
  (n.k === 'bin' && ((n.op === '*' && (isZeroNode(n.a) || isZeroNode(n.b))) || (n.op === '/' && isZeroNode(n.a))))

const mathId = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_')

/** Replace every symbol/param not in `keep` by its bound value; rename kept ones to math identifiers. */
const subst = (n: Node, keep: ReadonlySet<string>, b: Bindings): Node => {
  switch (n.k) {
    case 'const':
      return n
    case 'sym':
    case 'param':
      return keep.has(n.name) ? { k: 'sym', name: mathId(n.name) } : c(evalN(n, b))
    case 'bin':
      return { ...n, a: subst(n.a, keep, b), b: subst(n.b, keep, b) }
    case 'fn':
      return { ...n, args: n.args.map((a) => subst(a, keep, b)) }
    case 'opaque':
      throw new Error(`closed form: opaque function '${n.name}' has no closed form; bind its inputs numerically`)
  }
}

const toMath = (n: Node): string => {
  switch (n.k) {
    case 'const': {
      const v = fmtNum(n.v)
      return n.v < 0 ? `(${v})` : v
    }
    case 'sym':
    case 'param':
      return n.name
    case 'bin':
      return `(${toMath(n.a)} ${n.op} ${toMath(n.b)})`
    case 'fn':
      return `${n.name}(${n.args.map(toMath).join(', ')})`
    case 'opaque':
      return `${n.name}()`
  }
}

/** Every sink reachable from the root (pools are provisioned whether or not they are used). */
const reachableSinks = (root: GraphNode): Sink[] => {
  const seen = new Set<GraphNode>()
  const sinks = new Set<Sink>()
  const visit = (n: GraphNode) => {
    if (seen.has(n)) return
    seen.add(n)
    for (const s of Object.values(n.pools)) sinks.add(s)
    for (const d of Object.values(n.deps)) visit(d)
  }
  visit(root)
  return [...sinks]
}

const reachableFixed = (root: GraphNode) => {
  const seen = new Set<GraphNode>()
  const out: { dimension: BillingDimension; count: number }[] = []
  const visit = (n: GraphNode) => {
    if (seen.has(n)) return
    seen.add(n)
    out.push(...n.fixed)
    for (const d of Object.values(n.deps)) visit(d)
  }
  visit(root)
  return out
}

export const closedForm = (s: Scenario, opts: ClosedFormOptions = {}): ClosedForm => {
  const mode = opts.mode ?? 'exact'
  const w = singleWorkload(s, 'closedForm')
  const numeric = evaluate(s)

  // symbolize the workload: attrs → `<req>.<attr>`, gauges → `gauge.<name>`, bound to their scenario values
  // time-varying gauge levels (reference `time`) are evaluated at mid-period: exact for billing when the level
  // is linear in time; pool sizing uses the same (mid-period) level
  const timeVarying = Object.values(w.gauges).some((e) => refersTo(e.node, 'time'))
  const bindings: Record<string, number | Expr<any>> = {
    ...meanRateBindings(w),
    ...w.params,
    ...(timeVarying ? { time: w.periodSeconds / 2 } : {}),
  }
  const symbols: { name: string; value: number; unit: string }[] = []
  const addSym = (name: string, e: Expr<any>, unit: string): Expr<any> => {
    const value = e.eval(bindings)
    bindings[name] = value
    symbols.push({ name, value, unit })
    return new Expr<any>({ k: 'sym', name }, e.dim)
  }
  const requests: Record<string, Workload['requests'][string]> = {}
  const distAttrs: string[] = []
  for (const [name, load] of Object.entries(w.requests)) {
    if (!load) continue
    const attrs = Object.fromEntries(
      Object.entries(load.attrs).map(([k, v]) => {
        if (isDist(v)) {
          distAttrs.push(`${name}.${k}`)
          const e = v.meanExpr()
          return [k, addSym(`${name}.${k}`, e, unitName(e))]
        }
        return [k, addSym(`${name}.${k}`, v, unitName(v))]
      }),
    )
    requests[name] = { rate: load.rate, attrs }
  }
  // gauges derived from rates keep their expression, so the closed form stays a function of the rates
  const gauges = Object.fromEntries(
    Object.entries(w.gauges).map(([k, e]) => [
      k,
      refsRate(e.node) || refersTo(e.node, 'time') ? e : addSym(`gauge.${k}`, e, unitName(e)),
    ]),
  )
  const expansion = expand(withWorkload(s, { ...w, requests, gauges }))

  // mean and peak rate per request; peaks are assumed to coincide
  const steps = Math.round(w.periodSeconds / w.stepSeconds)
  const dt = w.periodSeconds / steps
  const rateSym: Record<string, Node> = {}
  const peakRatio: Record<string, number> = {}
  for (const { name } of expansion.requests) {
    const series = w.requests[name]!.rate
    const samples = new Float64Array(steps)
    for (let i = 0; i < steps; i++) samples[i] = series.at((i + 0.5) * dt)
    const mean = samples.reduce((a, v) => a + v, 0) / steps
    const peak = peakOf(samples, w.peak)
    const id = `rate.${name}`
    symbols.push({ name: id, value: mean, unit: 'req/s' })
    rateSym[name] = { k: 'sym', name: id }
    peakRatio[name] = mean > 0 ? peak / mean : 1
  }

  // effective USD per base unit, per dimension, at the operating point
  /** effective USD per base unit at the operating point, for the paying account when there are several */
  const priceOf = (d: BillingDimension, account?: string) => {
    const x =
      numeric.dimensions.find(
        (y) => y.id === d.id && (account === undefined || y.account === undefined || y.account === account),
      ) ?? numeric.dimensions.find((y) => y.id === d.id)
    return (x?.effectiveRate ?? 0) / d.usageUnit.scale
  }

  /** USD per instance (node) per month: instance-hours plus any volume */
  const perNodeMonth = (bills: readonly { dimension: BillingDimension; perSecond: number }[]) =>
    bills.reduce((a, x) => a + MONTH_SECONDS * x.perSecond * priceOf(x.dimension), 0)

  const terms: Node[] = []
  const assumptions: string[] = [
    'each billing dimension is priced at its effective rate at the operating point (tiers, discounts, region multiplier)',
  ]

  // usage-driven bills
  for (const r of expansion.requests) {
    for (const x of r.contribs) {
      if (x.kind !== 'bill') continue
      terms.push(mul(rateSym[r.name]!, c(MONTH_SECONDS * priceOf(x.dimension, x.account)), x.amount.node))
    }
  }
  for (const x of expansion.levels) {
    if (x.kind !== 'bill') continue
    terms.push(mul(c(MONTH_SECONDS * priceOf(x.dimension, x.account)), x.amount.node))
  }
  for (const f of reachableFixed(s.root.$node)) terms.push(c(f.count * MONTH_SECONDS * priceOf(f.dimension)))

  // capacity: peak demand per sink and resource, as expressions
  const demand = (sink: Sink, res: ResourceName): Node => {
    const parts: Node[] = []
    for (const r of expansion.requests) {
      for (const x of r.contribs) {
        if (x.kind === 'use' && x.sink === sink && x.resource === res) {
          parts.push(mul(rateSym[r.name]!, c(peakRatio[r.name]!), x.amount.node))
        }
      }
    }
    for (const x of expansion.levels)
      if (x.kind === 'use' && x.sink === sink && x.resource === res) parts.push(x.amount.node)
    return add(parts)
  }
  const bindingOf = (name: string) => numeric.pools.find((p) => p.name === name)?.binding
  const sinks = reachableSinks(s.root.$node)
  if (sinks.length) assumptions.push('capacity is sized from request peaks, assumed to coincide')

  /** the numeric binding resource when it is one of `dims`, else the first of them (cpu) */
  const bindingIn = <R extends ResourceName>(name: string, dims: readonly R[]): R => {
    const b = bindingOf(name)
    return dims.find((r) => r === b) ?? dims[0]!
  }
  const declared = (cap: Partial<Record<ResourceName, number>>): ResourceName[] =>
    Object.keys(cap).filter((r) => cap[r] !== undefined)

  for (const sink of sinks) {
    if (sink instanceof InstancePool) {
      const { instance, min, loadFactor, volumes } = sink.spec
      const cap: Partial<Record<ResourceName, number>> = {
        ...nodeCapacity(instance, bindings, volumes),
        ...customCapacities(sink, bindings),
      }
      const dims = declared(cap)
      const need = (res: ResourceName) => div(demand(sink, res), c(cap[res]! * loadFactor))
      const count =
        mode === 'exact' ? fmax(c(min), ...dims.map((r) => fceil(need(r)))) : need(bindingIn(sink.name, dims))
      terms.push(mul(count, c(perNodeMonth(perNodeBills(instance, bindings, volumes)))))
    }
  }

  const byNodePool = new Map<NodePool, PodGroup[]>()
  for (const sink of sinks) {
    if (sink instanceof PodGroup) byNodePool.set(sink.spec.on, [...(byNodePool.get(sink.spec.on) ?? []), sink])
  }
  for (const [np, groups] of byNodePool) {
    const { instance, min, reserved, maxPods, packingEfficiency, volumes } = np.spec
    const replicas = (g: PodGroup): Node => {
      const req = podRequests(g, bindings)
      const dims = declared(req)
      const need = (r: ResourceName) => div(demand(g, r), c(req[r]! * g.spec.targetUtilization))
      if (mode === 'exact') return fmax(c(g.spec.minReplicas), ...dims.map((r) => fceil(need(r))))
      return need(bindingIn(g.name, dims))
    }
    const cap = nodeCapacity(instance, bindings, volumes)
    const res: Partial<Record<Resource, number>> = {
      cpu: reserved.cpu.eval(bindings),
      memory: reserved.memory.eval(bindings),
    }
    const dims: Resource[] = [
      'cpu',
      'memory',
      ...(groups.some((g) => g.spec.request.network) ? ['network' as const] : []),
    ]
    const per = (r: Resource) => (cap[r]! - (res[r] ?? 0)) * packingEfficiency
    const requested = (r: Resource) => add(groups.map((g) => mul(replicas(g), c(podRequests(g, bindings)[r] ?? 0))))
    let nodes: Node
    if (mode === 'exact') {
      nodes = fmax(
        c(min),
        ...dims.map((r) => fceil(div(requested(r), c(per(r))))),
        fceil(div(add(groups.map(replicas)), c(maxPods))),
      )
    } else {
      const r = bindingIn(np.name, dims)
      nodes = div(requested(r), c(per(r)))
    }
    terms.push(mul(nodes, c(perNodeMonth(perNodeBills(instance, bindings, volumes)))))
  }
  if (timeVarying) {
    assumptions.push(
      'time-varying gauge levels are evaluated at mid-period (exact for storage billing when linear in time; pools are sized on that level, not on the end-of-period peak)',
    )
  }
  if (distAttrs.length) {
    assumptions.push(`distribution-valued attributes are replaced by their mean: ${distAttrs.join(', ')}`)
  }
  if (mode === 'relaxed') {
    assumptions.push(
      'relaxed: pools have no ceil() or minimum sizes and are sized on their binding dimension at the operating point (ceil() inside billing expressions, e.g. request units, is kept)',
    )
  }

  // keep / bind symbols and simplify
  const known = new Set(symbols.map((x) => x.name).concat(Object.keys(w.params)))
  const keep = new Set(opts.keep ?? symbols.filter((x) => x.name.startsWith('rate.')).map((x) => x.name))
  for (const k of keep)
    if (!known.has(k)) throw new Error(`closed form: unknown symbol '${k}' (known: ${[...known].join(', ')})`)
  const total = add(terms)
  const bound = subst(total, keep, bindings)
  const simplified = simplify(toMath(bound), {}, { exactFractions: false })
  const expression = simplified.toString({
    handler: (node: { type: string; value?: unknown }) =>
      node.type === 'ConstantNode' && typeof node.value === 'number' ? fmtNum(node.value) : undefined,
  })
  const value = evalN(total, bindings)
  const linear = linearize(bound, [...keep].map(mathId))

  return {
    quantity: 'total',
    unit: 'USD/month',
    mode,
    expression,
    value,
    numericTotal: numeric.total,
    symbols: symbols.map((x) => ({ ...x, id: mathId(x.name), kept: keep.has(x.name) })),
    ...(linear ? { linear } : {}),
    assumptions,
  }
}

doc({
  name: 'closedForm',
  kind: 'function',
  module: 'pricesim',
  summary:
    'Total monthly cost as a simplified formula over the symbols you keep (request rates, attributes, gauges, params).',
  signature: "closedForm(s: Scenario, opts?: { mode?: 'exact' | 'relaxed'; keep?: string[] }): ClosedForm",
  params: [
    { name: 's', type: 'Scenario', doc: 'A single-workload scenario (the operating point).' },
    {
      name: 'opts.mode',
      type: "'exact' | 'relaxed'",
      optional: true,
      default: "'exact'",
      doc: '`exact` keeps `ceil()` and minimum sizes per pool and the max over resources; `relaxed` drops them and sizes each pool on its binding resource at the operating point, so the formula is linear in the rates.',
    },
    {
      name: 'opts.keep',
      type: 'string[]',
      optional: true,
      default: 'every `rate.<request>`',
      doc: "Symbols left symbolic; everything else is bound to its scenario value. Names: `rate.<request>` (mean req/s), `<request>.<attr>`, `gauge.<name>`, or a param set in the workload's `params`. An unknown name throws and lists the known ones.",
    },
  ],
  returns: `A \`ClosedForm\`:
- \`expression\`: the simplified formula in USD/month over the kept symbols, in base units (req/s, byte, …). Symbol names have non-alphanumerics replaced by \`_\` (\`rate.upload\` → \`rate_upload\`).
- \`value\`: the formula at the scenario's values; \`numericTotal\`: \`evaluate(s).total\`, to compare.
- \`symbols\`: every symbol with its \`name\`, \`id\` (as in the expression), scenario \`value\`, \`unit\`, and \`kept\`.
- \`linear\` (when the formula is affine in the kept symbols): \`constant\` and \`perUnit[id]\`, e.g. USD/month per req/s.
- \`assumptions\`: what the formula takes for granted in this run.`,
  guidance: `
- **Pricing:** every billing dimension is priced at its effective rate from a numeric \`evaluate\` at the operating point (tiers, discounts, region multiplier). Far from that point, tiered prices make the formula drift.
- **Peaks:** pools are sized on each request's own peak-to-mean ratio, assuming all requests peak together. If they peak at different times, the formula overestimates pool cost relative to \`evaluate\`.
- **exact** equals \`numericTotal\` at the operating point when peaks coincide and no attribute is a distribution (distributions are replaced by their mean). **relaxed** is below exact (no rounding up, no minimums) and converges to it at scale; its \`linear.perUnit\` is the marginal cost per unit of each rate.
- Gauges derived from rates (\`workload({ gauges: ({ rate }) => … })\`) stay expressions in the rates, so their cost folds into the rate coefficients. Fixed gauge levels become \`gauge.<name>\` symbols.
- Levels that reference \`time\` are evaluated at mid-period: exact for storage billing when linear in time, but pools are sized on that level, not the end-of-period peak.
- Throws on \`opaque(…)\` functions in model logic (no closed form) and on multi-tenant scenarios.`,
  examples: [
    `import { bill, closedForm, dimension, pricing, q, request, scenario, series, service, u, workload } from 'pricesim'

const ops = dimension('api.ops', u.op, 1e-6)
const api = service('api', {
  requests: () => ({ call: request({ items: u.count }, (r) => ({ bill: [bill(ops, r.items.mul(q(1, u.op.div(u.count))))] })) }),
})
const s = scenario({
  name: 'api',
  root: api,
  pricing: pricing(),
  workload: workload(api, {
    requests: { call: { rate: series.constant(q(100, u.req.div(u.s))), attrs: { items: q(3, u.count) } } },
  }),
})

const cf = closedForm(s, { mode: 'relaxed' })
console.log(cf.expression) // e.g. "7.884 * rate_call"
const perReqPerSecond = cf.linear?.perUnit['rate_call'] // USD/month per 1 req/s

// cost as a function of rate and items per call
const both = closedForm(s, { keep: ['rate.call', 'call.items'] })`,
  ],
  seeAlso: ['evaluate', 'unitCosts', 'sweep', 'closed'],
  guide: 'analysis',
})

/** Coefficients if `n` is (numerically) affine in `ids`: probe at 0, unit vectors, and mixed points. */
const linearize = (n: Node, ids: readonly string[]) => {
  const at = (vals: Record<string, number>) => evalN(n, vals)
  const zero = Object.fromEntries(ids.map((id) => [id, 0]))
  const constant = at(zero)
  const perUnit: Record<string, number> = {}
  for (const id of ids) perUnit[id] = at({ ...zero, [id]: 1 }) - constant
  const probes = [7, 1234.5, 0.37].map((k, j) => Object.fromEntries(ids.map((id, i) => [id, k * (i + 1) + j * 3.3])))
  for (const p of probes) {
    const expected = constant + ids.reduce((a, id) => a + perUnit[id]! * p[id]!, 0)
    const actual = at(p)
    if (Math.abs(actual - expected) > 1e-6 * Math.max(1, Math.abs(actual))) return undefined
  }
  return { constant, perUnit }
}

const refsRate = (n: Node): boolean =>
  n.k === 'sym'
    ? n.name.startsWith('rate.')
    : n.k === 'bin'
      ? refsRate(n.a) || refsRate(n.b)
      : n.k === 'fn'
        ? n.args.some(refsRate)
        : n.k === 'opaque'
          ? Object.values(n.inputs).some(refsRate)
          : false

const unitName = (e: Expr<any>): string => {
  const d = e.dim
  const parts = Object.entries(d).map(([k, v]) => (v === 1 ? k : `${k}^${v}`))
  return parts.length ? parts.join('*') : '1'
}
