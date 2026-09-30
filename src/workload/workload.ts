// Workloads: request rates (time series) and attributes for the root node's request types, gauge levels,
// and param overrides (DESIGN.md §7).
import { Expr, max, min, q } from '../core/expr.ts'
import type { Mul } from '../core/dim.ts'
import { u } from '../core/units.ts'
import type { Callable, GaugeExprs } from '../model/node.ts'
import type { AttrExprs, GaugeDef, RequestDef } from '../model/request.ts'
import type { Dist } from './dist.ts'
import type { PeakSpec } from './peak.ts'
import type { Series } from './series.ts'
import { doc, docs } from '../docs/registry.ts'

type Rate = { req: 1; s: -1 }

export interface RequestLoad<A> {
  readonly rate: Series<Rate>
  readonly attrs: A
}

export interface WorkloadSpec<R extends Record<string, RequestDef<any>>, G extends Record<string, GaugeDef>> {
  /** length of the modeled period (default: one billing month, 730 h) */
  readonly period?: Expr<{ s: 1 }>
  /** evaluation step (default: 1 hour) */
  readonly step?: Expr<{ s: 1 }>
  readonly requests: { readonly [K in keyof R]?: RequestLoad<AttrInputs<AttrExprs<R[K]['attrs']>>> }
  /**
   * Gauge levels: expressions, or a function of the requests' mean rates so levels can be derived from
   * flows, e.g. `({ rate }) => ({ orders: rate.createOrder.mul(q(30, u.day)).mul(q(1, u.count.div(u.req))) })`.
   * Derived levels follow rate overrides (sweeps) and stay symbolic in closed forms.
   */
  readonly gauges?:
    | Partial<GaugeExprs<G>>
    | ((ctx: { readonly rate: MeanRates<R>; readonly time: Expr<{ s: 1 }> }) => Partial<GaugeExprs<G>>)
  /** param overrides by name, in base units or as expressions */
  readonly params?: Readonly<Record<string, number | Expr<any>>>
  /** how capacity peaks are measured over the time steps (default 'max') */
  readonly peak?: PeakSpec
  /** Monte Carlo samples per request type with distribution-valued attributes (default 64) */
  readonly samples?: number
  /** seed for all sampling (default 1) */
  readonly seed?: number
}

/** Request attributes: a fixed expression, or a distribution of values in the same dimension. */
export type AttrInputs<A> = { readonly [K in keyof A]: A[K] | (A[K] extends Expr<infer D> ? Dist<D> : never) }
export type AttrValue = Expr<any> | Dist<any>

export type MeanRates<R> = { readonly [K in keyof R]: Expr<Rate> }

/**
 * Seconds since the start of the modeled period (bound by the engine at every time step). Gauge levels that
 * reference it vary over the period, e.g. data that keeps accumulating.
 */
export const elapsed: Expr<{ s: 1 }> = new Expr<{ s: 1 }>({ k: 'sym', name: 'time' }, { s: 1 })

/**
 * Level retained from a constant inflow `rate` (per second), as a function of time in the period:
 *
 *   window  — with `retention`: rate × min(retention, age), where age = ageAtStart + time. The window fills,
 *             then stays flat: data drops off as fast as it arrives.
 *   forever — without `retention`: rate × age. Keeps growing; `ageAtStart` says how long it has been
 *             accumulating when the period starts (e.g. 12 months in).
 *
 * `ageAtStart` defaults to `retention` (a full, steady-state window) when retention is given, else 0.
 */
export const retained = <D>(opts: {
  rate: Expr<D>
  retention?: Expr<{ s: 1 }>
  ageAtStart?: Expr<{ s: 1 }>
}): Expr<Mul<D, { s: 1 }>> => {
  const age = (opts.ageAtStart ?? opts.retention ?? q(0, u.s)).add(elapsed)
  const window = opts.retention ? min(opts.retention, age) : max(q(0, u.s), age)
  return opts.rate.mul(window)
}

doc({
  name: 'retained',
  kind: 'function',
  module: 'pricesim',
  summary: 'The level retained from a constant inflow over time: a retention window, or data kept forever.',
  signature: 'retained(opts: { rate: Expr<X/s>; retention?: Expr<s>; ageAtStart?: Expr<s> }): Expr<X>',
  params: [
    {
      name: 'opts.rate',
      type: 'Expr<X/s>',
      doc: 'Inflow per second, e.g. `rate.put.mul(q(64, u.KB.div(u.req)))` (byte/s).',
    },
    {
      name: 'opts.retention',
      type: 'Expr<s>',
      optional: true,
      doc: 'How long data is kept. Omit it for data kept forever.',
    },
    {
      name: 'opts.ageAtStart',
      type: 'Expr<s>',
      optional: true,
      default: '`retention` if given, else 0',
      doc: 'How long data has been accumulating when the period starts.',
    },
  ],
  returns: 'A level (`rate × window`) that references `elapsed`; use it as a gauge level in `workload({ gauges })`.',
  guidance: `
- With \`retention\`: \`rate × min(retention, ageAtStart + time)\`. The default \`ageAtStart = retention\` is a full, steady window: constant \`rate × retention\`. Pass \`ageAtStart: q(0, u.day)\` for a fresh window that fills, then stays flat.
- Without \`retention\`: \`rate × (ageAtStart + time)\`; it keeps growing. Billing sees the period average (about \`ageAtStart\` + half a period); pools holding it are sized on the end-of-period level.
- \`closedForm\` evaluates \`time\` at mid-period, which is exact for storage billing but not for pool sizing.`,
  examples: [
    `import { q, retained, u } from 'pricesim'

const ingest = q(5, u.MB.div(u.s))
const week = retained({ rate: ingest, retention: q(7, u.day) }) // steady: 5 MB/s × 7 days
const archive = retained({ rate: ingest, ageAtStart: q(12, u.month) }) // month 13 of keep-forever`,
  ],
  seeAlso: ['elapsed', 'workload'],
  guide: 'workloads',
})

/** Symbol for the mean rate of a root request type over the period (bound by the engine). */
export const meanRate = (request: string): Expr<Rate> =>
  new Expr<Rate>({ k: 'sym', name: `rate.${request}` }, { req: 1, s: -1 })

/** Mean of a series over a workload's steps (hourly midpoints by default). */
export const seriesMean = (s: Series<any>, periodSeconds: number, stepSeconds: number): number => {
  const steps = Math.round(periodSeconds / stepSeconds)
  const dt = periodSeconds / steps
  let sum = 0
  for (let i = 0; i < steps; i++) sum += s.at((i + 0.5) * dt)
  return sum / steps
}

/** Bindings for every `rate.<request>` symbol: the mean of that request's series. */
export const meanRateBindings = (w: Workload): Record<string, number> =>
  Object.fromEntries(
    Object.entries(w.requests)
      .filter(([, l]) => l)
      .map(([n, l]) => [`rate.${n}`, seriesMean(l!.rate, w.periodSeconds, w.stepSeconds)]),
  )

export interface Workload {
  readonly periodSeconds: number
  readonly stepSeconds: number
  readonly requests: Readonly<Record<string, RequestLoad<Readonly<Record<string, AttrValue>>>>>
  readonly gauges: Readonly<Record<string, Expr<any>>>
  readonly params: Readonly<Record<string, number | Expr<any>>>
  readonly peak: PeakSpec
  readonly samples: number
  readonly seed: number
}

/** Define a workload against a root node; request names, attributes and gauges are type-checked. */
export const workload = <R extends Record<string, RequestDef<any>>, G extends Record<string, GaugeDef>>(
  _root: Callable<R, G>,
  spec: WorkloadSpec<R, G>,
): Workload => {
  const periodSeconds = (spec.period ?? q(730, u.hour)).eval()
  const stepSeconds = (spec.step ?? q(1, u.hour)).eval()
  if (!(stepSeconds > 0 && periodSeconds >= stepSeconds)) throw new Error('workload: need 0 < step <= period')
  return {
    periodSeconds,
    stepSeconds,
    requests: spec.requests as Workload['requests'],
    gauges: (typeof spec.gauges === 'function'
      ? spec.gauges({
          rate: Object.fromEntries(Object.keys(spec.requests).map((n) => [n, meanRate(n)])) as MeanRates<R>,
          time: elapsed,
        })
      : (spec.gauges ?? {})) as Workload['gauges'],
    params: spec.params ?? {},
    peak: spec.peak ?? 'max',
    samples: spec.samples ?? 64,
    seed: spec.seed ?? 1,
  }
}

doc({
  name: 'workload',
  kind: 'function',
  module: 'pricesim',
  summary: 'Traffic and stored data for a root node: request rates and attributes, gauge levels, param overrides.',
  signature: 'workload(root: Service | Offering, spec: WorkloadSpec): Workload',
  params: [
    {
      name: 'root',
      type: 'Service | Offering',
      doc: 'The node the scenario evaluates. Used only for type checking: request names, attribute units and gauge names must match it.',
    },
    {
      name: 'spec.requests',
      type: '{ [request]: { rate: Series<req/s>; attrs: { [attr]: Expr | Dist } } }',
      doc: 'Load per root request type. Types left out get no traffic. Each attribute is an expression or a `dist.*` distribution in the unit the request declares; a missing attribute throws at evaluation.',
    },
    {
      name: 'spec.gauges',
      type: '{ [gauge]: Expr } | ({ rate, time }) => { [gauge]: Expr }',
      optional: true,
      doc: "Root gauge levels (stored bytes, open connections, …). The function form gets `rate.<request>` (the symbol for that request's mean req/s) and `time` (`elapsed`), so levels can be derived from flows. Gauges left out are 0.",
    },
    {
      name: 'spec.params',
      type: '{ [name]: number | Expr }',
      optional: true,
      doc: 'Overrides for `param(name, default)` values in the model; numbers are in base units. Names the model does not use are ignored without error.',
    },
    { name: 'spec.period', type: 'Expr<s>', optional: true, default: '730 h', doc: 'Length of the modeled period.' },
    {
      name: 'spec.step',
      type: 'Expr<s>',
      optional: true,
      default: '1 h',
      doc: 'Evaluation step. Must satisfy 0 < step ≤ period.',
    },
    {
      name: 'spec.peak',
      type: "'max' | { percentile: number }",
      optional: true,
      default: "'max'",
      doc: 'How pools measure peak demand over the steps: the maximum, or a nearest-rank percentile in (0, 100] (ignores short spikes).',
    },
    {
      name: 'spec.samples',
      type: 'number',
      optional: true,
      default: '64',
      doc: 'Monte Carlo samples per request type that has distribution-valued attributes.',
    },
    { name: 'spec.seed', type: 'number', optional: true, default: '1', doc: 'Seed for all sampling.' },
  ],
  returns: "A `Workload`. Put it in `scenario({ workload })`, or in a tenant's `{ id, workload }`.",
  guidance: `
- The engine samples every rate series at the midpoint of each step. Usage (billing) is integrated over the steps; pools are sized on the peak step (or percentile) of each resource.
- Costs are always reported per month (730 h): a shorter or longer \`period\` is scaled to a month before tiers are applied.
- **Derived gauges:** write levels as a function of \`rate\` (e.g. \`rate.put × bytes per put × retention\`, or \`retained(…)\`) so they follow rate changes in \`sweep\`/\`capacity\` and stay symbolic in \`closedForm\`. A fixed number does not move when you sweep the rate.
- A level that references \`time\`/\`elapsed\` is evaluated at every step: billing uses the average, pools are sized on the peak step (usually the end of the period).
- **Distributions:** for an attribute given as \`dist.*\`, each of \`samples\` draws carries 1/samples of the requests, so non-linear bodies (\`ceil(bytes / 1 KB)\`) are costed per draw, not at the mean. Results are reproducible for a given \`seed\`.
- Rate series and attribute values are evaluated when built, so they can't depend on \`params\`.`,
  examples: [
    `import { bill, dimension, gauge, q, request, retained, series, service, u, workload } from 'pricesim'

const puts = dimension('blob.puts', u.op, 5e-6)
const storage = dimension('blob.storage', u.GB.mul(u.month), 0.023)
const blobs = service('blobs', {
  gauges: { stored: gauge(u.byte, { billAs: storage }) },
  requests: () => ({
    put: request({ bytes: u.byte }, () => ({ bill: [bill(puts, q(1, u.op))] })),
  }),
})

export const typical = workload(blobs, {
  requests: {
    put: {
      rate: series.diurnal({ mean: q(100, u.req.div(u.s)), peakToMean: 1.5 }),
      attrs: { bytes: q(64, u.KB) },
    },
  },
  // 30 days of puts retained, derived from the mean put rate
  gauges: ({ rate }) => ({
    stored: retained({ rate: rate.put.mul(q(64, u.KB.div(u.req))), retention: q(30, u.day) }),
  }),
})`,
  ],
  seeAlso: ['series', 'dist', 'retained', 'scenario', 'zipfTenants'],
  guide: 'workloads',
})

docs([
  {
    name: 'elapsed',
    kind: 'const',
    module: 'pricesim',
    summary: 'The symbol `time`: seconds since the start of the modeled period, bound at every step.',
    signature: 'elapsed: Expr<s>',
    guidance: `
- Use it in gauge levels that change over the period (data that keeps accumulating). It is the same symbol as \`time\` in the function form of \`workload({ gauges })\`.
- Evaluating an expression that contains it outside the engine throws (unbound symbol \`time\`).
- \`closedForm\` evaluates it at mid-period and says so in \`assumptions\`.`,
    seeAlso: ['retained', 'workload'],
    guide: 'workloads',
  },
  {
    name: 'meanRate',
    kind: 'function',
    module: 'pricesim',
    summary: 'The symbol `rate.<request>`: the mean req/s of a root request type over the period, bound by the engine.',
    signature: 'meanRate(request: string): Expr<req/s>',
    returns:
      'An expression for gauge levels or params. The `rate` object in `workload({ gauges: ({ rate }) => … })` holds these.',
    seeAlso: ['workload', 'meanRateBindings'],
    guide: 'workloads',
  },
  {
    name: 'seriesMean',
    kind: 'function',
    module: 'pricesim',
    summary: "Mean of a series over a workload's steps (sampled at step midpoints), in base units.",
    signature: 'seriesMean(s: Series, periodSeconds: number, stepSeconds: number): number',
    internal: true,
  },
  {
    name: 'meanRateBindings',
    kind: 'function',
    module: 'pricesim',
    summary: "Bindings `{ 'rate.<request>': mean req/s }` for every request with a load in the workload.",
    signature: 'meanRateBindings(w: Workload): Record<string, number>',
    returns:
      "Mean rates in req/s, keyed `rate.<request>`; handy for checking a workload's actual means (e.g. per tenant).",
    seeAlso: ['meanRate', 'seriesMean'],
  },
  {
    name: 'Workload',
    kind: 'type',
    module: 'pricesim',
    summary:
      'A resolved workload: `periodSeconds`, `stepSeconds`, `requests`, `gauges` (expressions), `params`, `peak`, `samples`, `seed`. Build it with `workload(…)`.',
    seeAlso: ['workload'],
    guide: 'workloads',
  },
])
