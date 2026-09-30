// Revenue and margin (DESIGN.md §8.2): meter each customer's workload, bill it under the price book (per
// customer: charges with tiers, discounts, fees, minimums), and compare with the provider's cost.
import type { Bindings } from '../core/expr.ts'
import { Expr, refersTo } from '../core/expr.ts'
import { MONTH_SECONDS } from '../core/units.ts'
import { doc, docs } from '../docs/registry.ts'
import { scheduleCost } from '../pricing/dimension.ts'
import { isDist } from '../workload/dist.ts'
import { rng } from '../workload/random.ts'
import { meanRateBindings, type Workload } from '../workload/workload.ts'
import { applies, elementName, resolvePlan, type Meter, type Plan, type PriceBook } from './price-book.ts'

/** One priced cost entry, as the evaluator produces them (path from the root, possibly tenant-prefixed). */
export interface CostEntry {
  readonly path: readonly { readonly name: string; readonly kind: string }[]
  readonly cost: number
  readonly kind: 'used' | 'idle' | 'fixed'
  readonly account: string
}

export interface RevenueLine {
  readonly name: string
  readonly kind: 'charge' | 'discount' | 'fee' | 'minimum'
  readonly meter?: string
  /** metered quantity in the meter's unit (charges) */
  readonly quantity?: number
  readonly unit?: string
  /** USD/month; negative for discounts */
  readonly amount: number
  /** charges: the amount after the discounts that cover it */
  readonly net?: number
}

export interface MeterMargin {
  readonly name: string
  readonly quantity: number
  readonly unit: string
  /** revenue from the charges on this meter, after discounts */
  readonly revenue: number
  /** provider cost attributed to the meter */
  readonly cost: number
  readonly margin: number
}

export interface CustomerRevenue {
  readonly id: string
  readonly plan: Plan
  readonly revenue: number
  readonly cost: number
  readonly margin: number
  /** margin / revenue; null without revenue */
  readonly marginRate: number | null
  readonly lines: readonly RevenueLine[]
  readonly meters: readonly MeterMargin[]
  /** provider cost no meter covers (idle, fixed, unmetered requests/gauges); 0 with proportional allocation */
  readonly unallocated: number
}

export interface RevenueResult {
  readonly priceBook: string
  readonly revenue: number
  /** the provider's cost (other accounts excluded) */
  readonly cost: number
  readonly margin: number
  readonly marginRate: number | null
  /** lines summed over customers, by name */
  readonly lines: readonly RevenueLine[]
  readonly meters: readonly MeterMargin[]
  readonly unallocated: number
  readonly customers: readonly CustomerRevenue[]
}

doc({
  name: 'RevenueResult',
  kind: 'type',
  module: 'pricesim',
  summary:
    '`evaluate(scenario).revenue` when the scenario has a `priceBook`: revenue, provider cost and margin, in USD/month.',
  guidance: `
- \`revenue\`, \`cost\` (provider account only), \`margin\` = revenue − cost, \`marginRate\` = margin / revenue (null when revenue is 0).
- \`lines\`: bill lines summed over customers by name (\`kind\` charge / discount / fee / minimum; charges carry \`quantity\`, \`unit\` and \`net\` after discounts; discounts are negative).
- \`meters\`: per meter \`quantity\` (in the meter's unit), \`revenue\` (its charges after discounts), \`cost\` (provider cost it claims) and \`margin\`.
- \`unallocated\`: cost no meter claims (0 with \`allocate: 'proportional'\` when some meter claims cost).
- \`customers\`: the same per customer, with its resolved \`plan\`. A single-workload scenario has one customer, whose id is the scenario name.`,
  seeAlso: ['priceBook', 'evaluate'],
  guide: 'revenue',
})

// ---------- metering ----------

/** Monthly quantity of every meter for one customer's workload, in each meter's unit. */
export const meterWorkload = (book: PriceBook, w: Workload, tenantId?: string): Record<string, number> => {
  const steps = Math.round(w.periodSeconds / w.stepSeconds)
  const dt = w.periodSeconds / steps
  const toMonth = MONTH_SECONDS / w.periodSeconds
  const b: Bindings = { ...meanRateBindings(w), ...(w.params as Bindings) }
  const out: Record<string, number> = {}
  for (const [name, m] of Object.entries(book.meters)) out[name] = meterOne(m, w, b, steps, dt, tenantId) * toMonth
  return out
}

doc({
  name: 'meterWorkload',
  kind: 'function',
  module: 'pricesim',
  summary: "Monthly quantity of every meter in a price book for one workload, in each meter's unit.",
  signature: 'meterWorkload(book: PriceBook, w: Workload, tenantId?: string): Record<string, number>',
  params: [
    { name: 'book', type: 'PriceBook', doc: 'The price book whose meters to evaluate.' },
    { name: 'w', type: 'Workload', doc: "A workload of the book's root." },
    {
      name: 'tenantId',
      type: 'string',
      optional: true,
      doc: 'Tenant id, used only to pick the same random stream as the cost side for distribution-valued attributes.',
    },
  ],
  returns: 'Meter name → quantity per 730-hour month. Request types and gauges absent from the workload count as 0.',
  guidance: `
- \`evaluate\` calls this for you; use it directly to check what a book meters before pricing it.
- Request rates are integrated per workload step and scaled from the workload period to a month; distribution-valued attributes use a Monte Carlo mean over the workload's \`samples\`.`,
  seeAlso: ['priceBook', 'billCustomer'],
  guide: 'revenue',
})

const meterOne = (m: Meter, w: Workload, b: Bindings, steps: number, dt: number, tenantId?: string): number => {
  if (m.kind === 'gauge') {
    const level = w.gauges[m.gauge]
    if (!level) return 0
    let total = 0
    if (refersTo(level.node, 'time')) {
      for (let i = 0; i < steps; i++) total += level.eval({ ...b, time: (i + 0.5) * dt }) * dt
    } else total = level.eval(b) * steps * dt
    return total / m.unit.scale
  }
  let total = 0
  for (const [req, f] of Object.entries(m.per)) {
    const load = w.requests[req]
    if (!load) continue
    // quantity per request: Monte Carlo mean over distribution-valued attributes, drawing the same samples as
    // the cost side (same seed and stream key as the usage expansion)
    const dists = Object.values(load.attrs).some(isDist)
    let per: number
    if (!dists) per = f(load.attrs as Record<string, Expr<any>>).eval(b)
    else {
      const r = rng(w.seed).fork(`${tenantId ?? ''}/${req}`)
      let sum = 0
      for (let i = 0; i < w.samples; i++) {
        const attrs = Object.fromEntries(
          Object.entries(load.attrs).map(([k, v]) => [
            k,
            isDist(v) ? new Expr<any>({ k: 'const', v: v.sample(r) }, v.dim) : (v as Expr<any>),
          ]),
        )
        sum += f(attrs).eval(b)
      }
      per = sum / w.samples
    }
    let requests = 0
    for (let i = 0; i < steps; i++) requests += load.rate.at((i + 0.5) * dt) * dt
    total += requests * per
  }
  return total / m.unit.scale
}

// ---------- billing ----------

/** One customer's bill under the book: charges (tiers per customer), discounts, fees, minimums. */
export const billCustomer = (
  book: PriceBook,
  quantities: Readonly<Record<string, number>>,
  plan: Plan,
): RevenueLine[] => {
  const els = book.prices.filter((e) => applies(e, plan))
  const lines: RevenueLine[] = []
  // charges
  const charged = new Map<string, number>()
  for (const e of els) {
    if (e.kind !== 'charge') continue
    const q = quantities[e.meter] ?? 0
    const amount = scheduleCost(e.schedule, q)
    charged.set(elementName(e), amount)
    lines.push({
      name: elementName(e),
      kind: 'charge',
      meter: e.meter,
      quantity: q,
      unit: book.meters[e.meter]!.unit.name,
      amount,
    })
  }
  // discounts: fractions off the covered charges (several discounts on one charge compound)
  const net = new Map(charged)
  for (const e of els) {
    if (e.kind !== 'discount') continue
    let off = 0
    for (const [n, a] of net) {
      if (e.covers && !e.covers.includes(n)) continue
      const d = a * e.fraction
      net.set(n, a - d)
      off += d
    }
    lines.push({ name: elementName(e), kind: 'discount', amount: -off })
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.kind === 'charge') lines[i] = { ...l, net: net.get(l.name)! }
  }
  // fees
  for (const e of els) {
    if (e.kind !== 'fee') continue
    net.set(elementName(e), e.amount)
    lines.push({ name: elementName(e), kind: 'fee', amount: e.amount })
  }
  // minimums: top up the covered charges and fees to the minimum
  for (const e of els) {
    if (e.kind !== 'minimum') continue
    let covered = 0
    for (const [n, a] of net) if (!e.covers || e.covers.includes(n)) covered += a
    lines.push({ name: elementName(e), kind: 'minimum', amount: Math.max(0, e.amount - covered) })
  }
  return lines
}

doc({
  name: 'billCustomer',
  kind: 'function',
  module: 'pricesim',
  summary: "One customer's bill lines under a price book, from its monthly meter quantities and plan.",
  signature: 'billCustomer(book: PriceBook, quantities: Record<string, number>, plan: Plan): RevenueLine[]',
  params: [
    { name: 'book', type: 'PriceBook', doc: 'The price book.' },
    {
      name: 'quantities',
      type: 'Record<string, number>',
      doc: 'Monthly quantity per meter, as from `meterWorkload`; missing meters count as 0.',
    },
    {
      name: 'plan',
      type: 'Plan',
      doc: "The customer's option values. Pass a resolved plan (every option set): an option left out here matches no `when`, since defaults are not filled in.",
    },
  ],
  returns:
    'Lines in order: charges (with `net` after discounts), discounts (negative), fees, minimum top-ups. Their `amount`s sum to the bill in USD/month.',
  seeAlso: ['priceBook', 'meterWorkload'],
  guide: 'revenue',
})

// ---------- margin ----------

/** the root-level request or gauge an entry's cost comes from */
const sourceOf = (path: CostEntry['path']): { request?: string; gauges?: string[] } => {
  const i = path.findIndex((s) => s.kind === 'request' || s.kind === 'gauges')
  if (i < 0) return {}
  if (path[i]!.kind === 'request') return { request: path[i]!.name }
  return {
    gauges: path
      .slice(i + 1)
      .filter((s) => s.kind === 'gauge')
      .map((s) => s.name),
  }
}

const claims = (m: Meter, src: ReturnType<typeof sourceOf>): boolean =>
  m.kind === 'requests'
    ? src.request !== undefined && src.request in m.per
    : src.gauges !== undefined && src.gauges.some((g) => (m.costFrom ?? [m.gauge]).includes(g))

export interface RevenueInput {
  readonly book: PriceBook
  /** customers: tenant id (undefined for a single-workload scenario), workload, plan */
  readonly customers: readonly { readonly id?: string; readonly workload: Workload; readonly plan?: Plan }[]
  /** priced cost entries of the provider account only */
  readonly entries: readonly CostEntry[]
  readonly singleId: string
}

export const computeRevenue = ({ book, customers, entries, singleId }: RevenueInput): RevenueResult => {
  const tenantOf = (e: CostEntry) => e.path.find((s) => s.kind === 'tenant')?.name
  const usedAll = entries.filter((e) => e.kind === 'used').reduce((a, e) => a + e.cost, 0)
  const overheadAll = entries.filter((e) => e.kind !== 'used').reduce((a, e) => a + e.cost, 0)
  const meterNames = Object.keys(book.meters)

  const out: CustomerRevenue[] = customers.map((c) => {
    const plan = resolvePlan(book, c.plan)
    const quantities = meterWorkload(book, c.workload, c.id)
    const lines = billCustomer(book, quantities, plan)
    const revenue = lines.reduce((a, l) => a + l.amount, 0)

    // revenue per meter: its charges after discounts (fees and minimum top-ups belong to no meter)
    const meterRevenue = Object.fromEntries(meterNames.map((n) => [n, 0]))
    for (const l of lines) if (l.kind === 'charge') meterRevenue[l.meter!]! += l.net!

    // provider cost: this customer's used entries, plus its share of idle and fixed
    const mine = entries.filter((e) => e.kind === 'used' && (c.id === undefined || tenantOf(e) === c.id))
    const used = mine.reduce((a, e) => a + e.cost, 0)
    const share = usedAll > 0 ? used / usedAll : 1 / customers.length
    const overhead = overheadAll * share
    const meterCost = Object.fromEntries(meterNames.map((n) => [n, 0]))
    let unclaimed = 0
    for (const e of mine) {
      const src = sourceOf(e.path)
      const by = meterNames.filter((n) => claims(book.meters[n]!, src))
      if (!by.length) {
        unclaimed += e.cost
        continue
      }
      // a cost claimed by several meters (e.g. write units and GiB on the same request) splits by revenue
      const weights = by.map((n) => meterRevenue[n]!)
      const wsum = weights.reduce((a, x) => a + x, 0)
      by.forEach((n, i) => (meterCost[n]! += e.cost * (wsum > 0 ? weights[i]! / wsum : 1 / by.length)))
    }
    let unallocated = unclaimed + overhead
    if (book.allocate === 'proportional') {
      const claimed = meterNames.reduce((a, n) => a + meterCost[n]!, 0)
      if (claimed > 0) {
        for (const n of meterNames) meterCost[n]! += unallocated * (meterCost[n]! / claimed)
        unallocated = 0
      }
    }
    const cost = used + overhead
    const meters: MeterMargin[] = meterNames.map((n) => ({
      name: n,
      quantity: quantities[n]!,
      unit: book.meters[n]!.unit.name,
      revenue: meterRevenue[n]!,
      cost: meterCost[n]!,
      margin: meterRevenue[n]! - meterCost[n]!,
    }))
    return {
      id: c.id ?? singleId,
      plan,
      revenue,
      cost,
      margin: revenue - cost,
      marginRate: revenue > 0 ? (revenue - cost) / revenue : null,
      lines,
      meters,
      unallocated,
    }
  })

  const sumBy = <T>(items: readonly T[], key: (t: T) => string, merge: (a: T, b: T) => T) => {
    const m = new Map<string, T>()
    for (const it of items) {
      const k = key(it)
      const prev = m.get(k)
      m.set(k, prev ? merge(prev, it) : it)
    }
    return [...m.values()]
  }
  const lines = sumBy(
    out.flatMap((c) => c.lines),
    (l) => l.name,
    (a, b) => ({
      ...a,
      amount: a.amount + b.amount,
      ...(a.quantity !== undefined ? { quantity: a.quantity + (b.quantity ?? 0) } : {}),
      ...(a.net !== undefined ? { net: a.net + (b.net ?? 0) } : {}),
    }),
  )
  const meters = sumBy(
    out.flatMap((c) => c.meters),
    (m) => m.name,
    (a, b) => ({
      ...a,
      quantity: a.quantity + b.quantity,
      revenue: a.revenue + b.revenue,
      cost: a.cost + b.cost,
      margin: a.margin + b.margin,
    }),
  )
  const revenue = out.reduce((a, c) => a + c.revenue, 0)
  const cost = out.reduce((a, c) => a + c.cost, 0)
  return {
    priceBook: book.name,
    revenue,
    cost,
    margin: revenue - cost,
    marginRate: revenue > 0 ? (revenue - cost) / revenue : null,
    lines,
    meters,
    unallocated: out.reduce((a, c) => a + c.unallocated, 0),
    customers: out,
  }
}

docs([
  {
    name: 'computeRevenue',
    kind: 'function',
    module: 'pricesim',
    summary:
      "Revenue and margin for a scenario's customers from the provider's priced cost entries; `evaluate` calls it when the scenario has a `priceBook`.",
    internal: true,
  },
])
