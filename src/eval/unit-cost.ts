// Unit cost of each root request type in isolation at a constant rate (DESIGN.md §8 `unitCost`).
// Each request type is evaluated alone, with the scenario's attributes for it, so the minimum-size tax and
// fixed charges show up in the all-in number.
import { MONTH_SECONDS } from '../core/units.ts'
import type { Workload } from '../workload/workload.ts'
import { evaluate, type Result } from './evaluate.ts'
import { singleWorkload, withWorkload, type Scenario } from './scenario.ts'
import { doc } from '../docs/registry.ts'

export interface UnitCost {
  readonly request: string
  /** req/s, constant for the whole period */
  readonly rate: number
  readonly requestsPerMonth: number
  readonly total: number
  readonly used: number
  readonly idle: number
  readonly fixed: number
  /** USD per million requests: request-driven cost only, and all-in (incl. idle + fixed); all-in is Infinity at rate 0 */
  readonly perMillion: { readonly used: number; readonly allIn: number }
  /** request-driven cost by direct child of the request (dependencies, pools, network) */
  readonly breakdown: readonly { readonly name: string; readonly kind: string; readonly cost: number }[]
  readonly pools: readonly { readonly name: string; readonly count: number; readonly binding: string }[]
}

export interface UnitCostOptions {
  /** req/s to evaluate each request type at */
  readonly rate: number
  /** subset of root request types (default: all with a load in the scenario's workload) */
  readonly requests?: readonly string[]
  /** include the workload's gauges (stored data); default false, so the cost is the request's own */
  readonly includeGauges?: boolean
}

export const unitCosts = (s: Scenario, opts: UnitCostOptions): { results: UnitCost[]; runs: Result[] } => {
  const w = singleWorkload(s, 'unitCosts')
  if (!(opts.rate >= 0)) throw new Error('unitCosts: rate must be >= 0')
  const names = opts.requests ?? Object.keys(w.requests)
  const results: UnitCost[] = []
  const runs: Result[] = []
  for (const name of names) {
    const load = w.requests[name]
    if (!load) throw new Error(`unit-cost: no load for '${name}' in the scenario workload (need its attributes)`)
    const single: Workload = {
      ...w,
      requests: { [name]: { rate: { describe: `constant(${opts.rate})`, at: () => opts.rate }, attrs: load.attrs } },
      gauges: opts.includeGauges ? w.gauges : {},
    }
    const r = evaluate(withWorkload(s, single, `${s.name}:${name}`))
    runs.push(r)
    const reqs = opts.rate * MONTH_SECONDS // costs are reported per month
    // with several payers the tree's first level is the account: merge the request's children across accounts
    const tops = (r.tree.children ?? []).flatMap((c) => (c.kind === 'account' ? (c.children ?? []) : [c]))
    const merged = new Map<string, { name: string; kind: string; cost: number }>()
    for (const top of tops.filter((c) => c.kind === 'service' || c.kind === 'offering'))
      for (const c of top.children?.find((x) => x.name === name)?.children ?? []) {
        const k = `${c.kind}:${c.name}`
        const prev = merged.get(k)
        merged.set(k, { name: c.name, kind: c.kind, cost: (prev?.cost ?? 0) + c.cost })
      }
    results.push({
      request: name,
      rate: opts.rate,
      requestsPerMonth: reqs,
      total: r.total,
      used: r.used,
      idle: r.idle,
      fixed: r.fixed,
      // no requests → no per-request cost (the idle/fixed cost is still reported in total/idle/fixed)
      perMillion:
        reqs > 0 ? { used: (r.used / reqs) * 1e6, allIn: (r.total / reqs) * 1e6 } : { used: 0, allIn: Infinity },
      breakdown: [...merged.values()].sort((a, b) => b.cost - a.cost),
      pools: r.pools.map((p) => ({ name: p.name, count: p.count, binding: p.binding })),
    })
  }
  return { results, runs }
}

doc({
  name: 'unitCosts',
  kind: 'function',
  module: 'pricesim',
  summary: 'Cost per request type: each root request type evaluated alone at a constant rate.',
  signature:
    'unitCosts(s: Scenario, opts: { rate: number; requests?: string[]; includeGauges?: boolean }): { results: UnitCost[]; runs: Result[] }',
  params: [
    {
      name: 's',
      type: 'Scenario',
      doc: 'A single-workload scenario; its attributes for each request type are reused.',
    },
    {
      name: 'opts.rate',
      type: 'number (req/s)',
      doc: 'Constant rate for each request type, for the whole period. Must be ≥ 0.',
    },
    {
      name: 'opts.requests',
      type: 'string[]',
      optional: true,
      doc: 'Root request types to cost (default: every one with a load in the workload). Each must have a load in the workload (for its attributes), else it throws.',
    },
    {
      name: 'opts.includeGauges',
      type: 'boolean',
      optional: true,
      default: 'false',
      doc: "Keep the workload's gauge levels (stored data). By default they are dropped so the cost is the request's own.",
    },
  ],
  returns: `\`results\`: one \`UnitCost\` per request type, and \`runs\`: the full \`Result\` of each run (same order). A \`UnitCost\` has:
- \`request\`, \`rate\` (req/s), \`requestsPerMonth\` (rate × 730 h).
- \`total\`, \`used\`, \`idle\`, \`fixed\` in USD/month for the whole deployment at that rate.
- \`perMillion.used\`: request-driven USD per million requests; \`perMillion.allIn\`: total (incl. idle and fixed) per million (\`Infinity\` at rate 0).
- \`breakdown\`: request-driven cost by direct child of the request (called services and offerings, pools, network).
- \`pools\`: \`name\`, \`count\`, \`binding\` per pool.`,
  guidance: `
- Each type runs **alone**, so all-in cost carries the whole deployment's minimum sizes and fixed charges. Compare \`allIn\` at a low and a high rate to see where minimums stop mattering; \`used\` per million stays flat when the request's cost is linear.
- It is not the marginal cost of a request inside the mixed workload (requests share pools). For that, read \`closedForm(s, { mode: 'relaxed' }).linear.perUnit\`.
- The period, step, params and peak setting come from the scenario's workload; rate-derived gauges are dropped too unless \`includeGauges\`.
- With several payer accounts, \`breakdown\` sums each child across accounts.`,
  examples: [
    `import { bill, dimension, pricing, q, request, scenario, series, service, u, unitCosts, workload } from 'pricesim'

const ops = dimension('api.ops', u.op, 1e-6)
const api = service('api', {
  requests: () => ({ call: request({}, () => ({ bill: [bill(ops, q(2, u.op))] })) }),
})
const s = scenario({
  name: 'api',
  root: api,
  pricing: pricing(),
  workload: workload(api, { requests: { call: { rate: series.constant(q(10, u.req.div(u.s))), attrs: {} } } }),
})

const { results } = unitCosts(s, { rate: 1000 })
for (const r of results) console.log(r.request, r.perMillion.used, r.perMillion.allIn) // USD per million`,
  ],
  seeAlso: ['closedForm', 'evaluate', 'unit-cost'],
  guide: 'analysis',
})
