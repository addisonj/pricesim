// Sweeps (DESIGN.md §8): evaluate a scenario over a grid of overrides and return one row per point.
//
// Variables (values in base units: req/s, bytes, …):
//   rate.<request>    mean request rate; the request's series is scaled to have this mean
//   <request>.<attr>  request attribute
//   gauge.<name>      root gauge level
//   <param>           param override
import { Expr } from '../core/expr.ts'
import type { Series } from '../workload/series.ts'
import { seriesMean, type Workload } from '../workload/workload.ts'
import { evaluate, type Result } from './evaluate.ts'
import { singleWorkload, withWorkload, type Scenario } from './scenario.ts'
import { doc, docs } from '../docs/registry.ts'

export type SweepVars = Readonly<Record<string, readonly number[]>>

export interface SweepRow {
  readonly inputs: Readonly<Record<string, number>>
  readonly total: number
  readonly used: number
  readonly idle: number
  readonly fixed: number
  /** cost per billing dimension id */
  readonly dimensions: Readonly<Record<string, number>>
  /** provisioned count per pool */
  readonly pools: Readonly<Record<string, number>>
}

/** `n` evenly spaced values from `from` to `to` (inclusive), optionally log-spaced. */
export const range = (from: number, to: number, n: number, opts: { log?: boolean } = {}): number[] => {
  if (n < 1) throw new Error('range: n must be >= 1')
  if (n === 1) return [from]
  if (opts.log) {
    if (!(from > 0 && to > 0)) throw new Error('range: log spacing needs positive bounds')
    const a = Math.log(from)
    const b = Math.log(to)
    return Array.from({ length: n }, (_, i) => Math.exp(a + ((b - a) * i) / (n - 1)))
  }
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1))
}

const meanOf = (s: Series<any>, w: Workload) => seriesMean(s, w.periodSeconds, w.stepSeconds)

/** Apply one point's overrides to a scenario. */
export const withOverrides = (s: Scenario, point: Readonly<Record<string, number>>): Scenario => {
  const w = singleWorkload(s, 'sweep')
  const requests = { ...w.requests } as Record<string, NonNullable<Workload['requests'][string]>>
  const gauges = { ...w.gauges } as Record<string, Expr<any>>
  const params = { ...w.params } as Record<string, number | Expr<any>>
  const constLike = (e: { readonly dim: Expr<any>['dim'] } | undefined, v: number, what: string) => {
    if (!e) throw new Error(`sweep: unknown variable '${what}'`)
    return new Expr<any>({ k: 'const', v }, e.dim)
  }
  for (const [name, v] of Object.entries(point)) {
    if (name.startsWith('rate.')) {
      const req = name.slice(5)
      const load = requests[req]
      if (!load) throw new Error(`sweep: no request '${req}' in the workload`)
      const mean = meanOf(load.rate, w)
      const base = load.rate
      const rate: Series<any> =
        mean > 0
          ? { describe: `${base.describe} × ${v / mean}`, at: (t) => (base.at(t) * v) / mean }
          : { describe: `constant(${v})`, at: () => v }
      requests[req] = { ...load, rate }
    } else if (name.startsWith('gauge.')) {
      const g = name.slice(6)
      gauges[g] = constLike(gauges[g], v, name)
    } else if (name.includes('.')) {
      const [req, attr] = name.split('.', 2) as [string, string]
      const load = requests[req]
      if (!load) throw new Error(`sweep: no request '${req}' in the workload`)
      requests[req] = { ...load, attrs: { ...load.attrs, [attr]: constLike(load.attrs[attr], v, name) } }
    } else {
      params[name] = v
    }
  }
  return withWorkload(s, { ...w, requests, gauges, params })
}

const toRow = (inputs: Record<string, number>, r: Result): SweepRow => ({
  inputs,
  total: r.total,
  used: r.used,
  idle: r.idle,
  fixed: r.fixed,
  dimensions: Object.fromEntries(r.dimensions.map((d) => [d.id, d.cost])),
  pools: Object.fromEntries(r.pools.map((p) => [p.name, p.count])),
})

/** Evaluate every point of the cartesian product of `vars`. */
export const sweep = (s: Scenario, vars: SweepVars): SweepRow[] => {
  const names = Object.keys(vars)
  const rows: SweepRow[] = []
  const walk = (i: number, point: Record<string, number>) => {
    if (i === names.length) {
      rows.push(toRow({ ...point }, evaluate(withOverrides(s, point))))
      return
    }
    for (const v of vars[names[i]!]!) walk(i + 1, { ...point, [names[i]!]: v })
  }
  walk(0, {})
  return rows
}

doc({
  name: 'sweep',
  kind: 'function',
  module: 'pricesim',
  summary:
    'Evaluate a scenario at every point of a grid of overrides (rates, attributes, gauges, params); one row per point.',
  signature: 'sweep(s: Scenario, vars: Record<string, number[]>): SweepRow[]',
  params: [
    { name: 's', type: 'Scenario', doc: 'A single-workload scenario (the base point).' },
    {
      name: 'vars',
      type: 'Record<string, number[]>',
      doc: 'Variable name → values, in base units (req/s, byte, …). Names: `rate.<request>`, `<request>.<attr>`, `gauge.<name>`, or anything else as a param name. See `withOverrides`.',
    },
  ],
  returns: `\`SweepRow[]\`, one per point of the cartesian product, in order (the last variable varies fastest). Each row: \`inputs\` (the point), \`total\`, \`used\`, \`idle\`, \`fixed\` (USD/month), \`dimensions\` (cost per billing dimension id), \`pools\` (count per pool). \`sweepCsv(rows)\` writes it as CSV.`,
  guidance: `
- Every point is a full \`evaluate\`, so tiers, minimum sizes and \`ceil()\` all show; the grid size is the product of the value counts.
- \`rate.<request>\` rescales that request's series to the given mean, keeping its shape (a diurnal curve stays diurnal, peaks scale with it). A series with mean 0 becomes constant.
- Gauges derived from rates in the workload follow \`rate.*\` overrides; \`gauge.<name>\` replaces a level with a constant.
- \`<request>.<attr>\` replaces the attribute (even a distribution) with a constant.
- A name without a dot is taken as a param and is **not** checked: a misspelt param changes nothing. Unknown requests, attributes and gauges throw.
- Use \`range\` for evenly or log-spaced values; for a formula instead of a table, use \`closedForm\`.
- CLI: \`pricesim sweep model.ts --var rate.upload=10..1000:log:5 [--csv]\`.`,
  examples: [
    `import { bill, dimension, pricing, q, range, request, scenario, series, service, sweep, sweepCsv, u, workload } from 'pricesim'

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

// 5 log-spaced rates × 2 batch sizes = 10 evaluations
const rows = sweep(s, { 'rate.call': range(10, 10_000, 5, { log: true }), 'call.items': [1, 10] })
const csv = sweepCsv(rows)`,
  ],
  seeAlso: ['withOverrides', 'range', 'sweepCsv', 'closedForm'],
  guide: 'analysis',
})

/** CSV with one column per input, totals, then per-dimension costs and pool counts. */
export const sweepCsv = (rows: readonly SweepRow[]): string => {
  if (!rows.length) return ''
  const inputs = Object.keys(rows[0]!.inputs)
  const dims = [...new Set(rows.flatMap((r) => Object.keys(r.dimensions)))].sort()
  const pools = [...new Set(rows.flatMap((r) => Object.keys(r.pools)))].sort()
  const header = [
    ...inputs,
    'total',
    'used',
    'idle',
    'fixed',
    ...dims.map((d) => `dim:${d}`),
    ...pools.map((p) => `pool:${p}`),
  ]
  const num = (v: number | undefined) => (v === undefined ? '' : String(Number(v.toPrecision(8))))
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = [header.map(esc).join(',')]
  for (const r of rows) {
    lines.push(
      [
        ...inputs.map((k) => num(r.inputs[k])),
        num(r.total),
        num(r.used),
        num(r.idle),
        num(r.fixed),
        ...dims.map((d) => num(r.dimensions[d] ?? 0)),
        ...pools.map((p) => num(r.pools[p])),
      ].join(','),
    )
  }
  return lines.join('\n') + '\n'
}

/** Parse a CLI spec: `a..b[:log][:n]` or a comma list `v1,v2,…`. */
export const parseRangeSpec = (spec: string): number[] => {
  const m = /^([-+\d.e]+)\.\.([-+\d.e]+)((?::log|:\d+)*)$/i.exec(spec.trim())
  if (m) {
    const flags = m[3]!.split(':').filter(Boolean)
    const n = Number(flags.find((f) => /^\d+$/.test(f)) ?? 10)
    return range(Number(m[1]), Number(m[2]), n, { log: flags.includes('log') })
  }
  const vals = spec.split(',').map(Number)
  if (!vals.length || vals.some((v) => !Number.isFinite(v))) throw new Error(`cannot parse range '${spec}'`)
  return vals
}

docs([
  {
    name: 'range',
    kind: 'function',
    module: 'pricesim',
    summary: '`n` evenly spaced values from `from` to `to`, inclusive; log-spaced with `{ log: true }`.',
    signature: 'range(from: number, to: number, n: number, opts?: { log?: boolean }): number[]',
    guidance: '- `n = 1` gives `[from]`; `n < 1` throws. Log spacing needs positive bounds.',
    examples: [
      `import { range } from 'pricesim'

range(0, 10, 3) // [0, 5, 10]
range(10, 1000, 3, { log: true }) // [10, 100, 1000] (up to rounding)`,
    ],
    seeAlso: ['sweep', 'parseRangeSpec'],
  },
  {
    name: 'withOverrides',
    kind: 'function',
    module: 'pricesim',
    summary: "A copy of a single-workload scenario with one sweep point's overrides applied.",
    signature: 'withOverrides(s: Scenario, point: Record<string, number>): Scenario',
    params: [
      {
        name: 'point',
        type: 'Record<string, number>',
        doc: 'Values in base units: `rate.<request>` (new mean req/s; the series is rescaled), `<request>.<attr>` (constant attribute), `gauge.<name>` (constant level), otherwise a param name.',
      },
    ],
    returns: 'A new `Scenario`; pass it to `evaluate` or another analysis.',
    guidance:
      '- Throws for an unknown request, attribute or gauge, and for multi-tenant scenarios. Param names are not checked.',
    seeAlso: ['sweep', 'evaluate'],
  },
  {
    name: 'sweepCsv',
    kind: 'function',
    module: 'pricesim',
    summary:
      'CSV of sweep rows: one column per input, then total, used, idle, fixed, `dim:<id>` costs and `pool:<name>` counts.',
    signature: 'sweepCsv(rows: SweepRow[]): string',
    returns: 'CSV text ending in a newline (empty string for no rows). Numbers have 8 significant digits.',
    seeAlso: ['sweep'],
  },
  {
    name: 'parseRangeSpec',
    kind: 'function',
    module: 'pricesim',
    summary: 'Parse a CLI range spec: `a..b[:log][:n]` (n defaults to 10) or a comma list `v1,v2,…`.',
    signature: 'parseRangeSpec(spec: string): number[]',
    seeAlso: ['range', 'sweep'],
    internal: true,
  },
])
