// Price books (DESIGN.md §8.2): what the provider charges its customers. Meters turn the root's traffic into
// billable quantities; price elements (charges, fees, minimums, discounts) price them, optionally depending on
// options each customer picks in its plan.
import type { Mul } from '../core/dim.ts'
import { doc, docs } from '../docs/registry.ts'
import type { Expr } from '../core/expr.ts'
import type { Unit } from '../core/units.ts'
import type { Callable } from '../model/node.ts'
import type { AttrExprs, GaugeDef, RequestDef } from '../model/request.ts'
import type { PriceSchedule } from '../pricing/dimension.ts'

type AnyAttrs = Readonly<Record<string, Expr<any>>>

/** Quantity per root request of the listed types, from the request's attributes. */
export interface RequestMeter {
  readonly kind: 'requests'
  readonly per: Readonly<Record<string, (attrs: AnyAttrs) => Expr<any>>>
  readonly unit: Unit<any>
}

/** A root gauge's level × time. */
export interface GaugeMeter {
  readonly kind: 'gauge'
  readonly gauge: string
  readonly unit: Unit<any>
  /** gauge names further down the graph whose cost this meter covers (default: the gauge's own name) */
  readonly costFrom?: readonly string[]
}

export type Meter = RequestMeter | GaugeMeter

type GaugeDim<G> = G extends GaugeDef<infer D> ? D : never

/** Builds meters typed against the root's request types and gauges. */
export interface MeterBuilder<R extends Record<string, RequestDef<any>>, G extends Record<string, GaugeDef>> {
  /**
   * Quantity per request, in `unit`, for each listed root request type, e.g.
   * `requests({ append: (r) => ceil(r.bytes.div(q(1, u.KiB))) }, u.count)`.
   */
  requests<D>(per: { readonly [K in keyof R]?: (r: AttrExprs<R[K]['attrs']>) => Expr<D> }, unit: Unit<D>): RequestMeter
  /** The gauge's level integrated over time, in `unit` (level × time, e.g. `stream.mul(u.month)`). */
  gauge<K extends keyof G & string>(
    name: K,
    unit: Unit<Mul<GaugeDim<G[K]>, { s: 1 }>>,
    opts?: { readonly costFrom?: readonly string[] },
  ): GaugeMeter
}

const meterBuilder: MeterBuilder<any, any> = {
  requests: (per, unit) => ({ kind: 'requests', per: per as RequestMeter['per'], unit }),
  gauge: (name, unit, opts) => ({
    kind: 'gauge',
    gauge: name,
    unit,
    ...(opts?.costFrom ? { costFrom: opts.costFrom } : {}),
  }),
}

/** A customer choice, e.g. `{ values: ['public', 'privatelink'], default: 'public' }`. */
export interface OptionDef {
  readonly values: readonly string[]
  readonly default: string
}
export type Options = Readonly<Record<string, OptionDef>>

/** A plan (or a `when` condition): one value per option. */
export type PlanOf<O extends Options> = { readonly [K in keyof O]?: O[K]['values'][number] }
export type Plan = Readonly<Record<string, string>>

interface ElementBase {
  readonly name?: string
  /** applies only to customers whose plan matches every listed option */
  readonly when?: Plan
}

export interface Charge<M extends string = string> extends ElementBase {
  readonly kind: 'charge'
  readonly meter: M
  readonly schedule: PriceSchedule
}
export interface Fee extends ElementBase {
  readonly kind: 'fee'
  /** USD per customer per month */
  readonly amount: number
}
export interface Minimum extends ElementBase {
  readonly kind: 'minimum'
  /** USD per customer per month */
  readonly amount: number
  /** names of the charges and fees it covers (default: all that apply to the customer) */
  readonly covers?: readonly string[]
}
export interface Discount extends ElementBase {
  readonly kind: 'discount'
  /** fraction off, 0..1 */
  readonly fraction: number
  /** names of the charges it applies to (default: all that apply to the customer) */
  readonly covers?: readonly string[]
}

export type PriceElement<M extends string = string> = Charge<M> | Fee | Minimum | Discount

const schedule = (s: PriceSchedule | number): PriceSchedule => (typeof s === 'number' ? { kind: 'flat', rate: s } : s)

/** Price a meter. Its name defaults to the meter's (they must be unique across the book). */
export const charge = <M extends string>(
  meter: M,
  price: PriceSchedule | number,
  opts: { readonly name?: string; readonly when?: Plan } = {},
): Charge<M> => ({ kind: 'charge', meter, schedule: schedule(price), ...opts })

doc({
  name: 'charge',
  kind: 'function',
  module: 'pricesim',
  summary: 'A price element that bills a meter of a price book at a flat rate or a schedule.',
  signature: 'charge(meter: string, price: PriceSchedule | number, opts?: { name?: string; when?: Plan }): Charge',
  params: [
    {
      name: 'meter',
      type: 'string',
      doc: "A meter name from the book's `meters`; checked at compile time and by `priceBook`.",
    },
    {
      name: 'price',
      type: 'PriceSchedule | number',
      doc: 'USD per 1 unit of the meter (its `unit`). A number is a flat rate; `tiered([...])` and `freeTier(n, rate)` work as on billing dimensions.',
    },
    {
      name: 'opts.name',
      type: 'string',
      optional: true,
      doc: 'Line name in the bill; must be unique in the book. Default: the meter name, plus ` (option=value, …)` when `when` is set.',
    },
    {
      name: 'opts.when',
      type: 'Plan',
      optional: true,
      doc: "Applies only to customers whose plan has every listed option value, e.g. `{ network: 'privatelink' }`.",
    },
  ],
  returns: "A `Charge`; put it in the book's `prices`.",
  guidance: `
- Tiers and free tiers apply to each customer's own monthly quantity, not to the sum over customers.
- One meter can feed several charges, e.g. a base rate for everyone plus a surcharge \`when\` an option is picked. Give the second one a \`name\` if the default names would collide.
- The line shows \`amount\` (before discounts) and \`net\` (after the discounts that cover it).`,
  examples: [
    `import { charge, freeTier, tiered } from 'pricesim'

const perGB = charge('transferGB', 0.05)
const tiers = charge(
  'transferGB',
  tiered([
    { upTo: 10_000, rate: 0.02 },
    { upTo: null, rate: 0.015 },
  ]),
  { name: 'tiered transfer' },
)
const surcharge = charge('transferGB', 0.03, { when: { network: 'privatelink' }, name: 'privatelink transfer' })
const files = charge('fileMonths', freeTier(100_000, 0.0001))`,
  ],
  seeAlso: ['priceBook', 'fee', 'minimum', 'discount', 'tiered', 'freeTier'],
  guide: 'revenue',
})

/** A fixed amount per customer per month. */
export const fee = (amount: number, opts: { readonly name?: string; readonly when?: Plan } = {}): Fee => ({
  kind: 'fee',
  amount,
  ...opts,
})

doc({
  name: 'fee',
  kind: 'function',
  module: 'pricesim',
  summary: 'A price element: a fixed USD amount per customer per month.',
  signature: 'fee(amount: number, opts?: { name?: string; when?: Plan }): Fee',
  params: [
    { name: 'amount', type: 'number', doc: 'USD per customer per month.' },
    {
      name: 'opts.name',
      type: 'string',
      optional: true,
      doc: 'Line name; default `fee`, plus ` (option=value, …)` with `when`.',
    },
    {
      name: 'opts.when',
      type: 'Plan',
      optional: true,
      doc: 'Applies only to customers whose plan matches every listed option.',
    },
  ],
  returns: "A `Fee`; put it in the book's `prices`.",
  guidance: `
- Charged to every customer the fee applies to, whatever its usage.
- Discounts never reduce fees. Minimums count fees (all of them by default, or those named in \`covers\`).
- Fee revenue belongs to no meter, so it shows in the customer's and total margin but not in per-meter margin.`,
  examples: [
    `import { fee } from 'pricesim'

const support = fee(500, { when: { support: 'premium' }, name: 'premium support' })`,
  ],
  seeAlso: ['priceBook', 'minimum'],
  guide: 'revenue',
})

/** The customer pays at least `amount` per month for the covered charges and fees (a top-up line). */
export const minimum = (
  amount: number,
  opts: { readonly name?: string; readonly when?: Plan; readonly covers?: readonly string[] } = {},
): Minimum => ({ kind: 'minimum', amount, ...opts })

doc({
  name: 'minimum',
  kind: 'function',
  module: 'pricesim',
  summary: 'A price element: a monthly minimum per customer, billed as a top-up line.',
  signature: 'minimum(amount: number, opts?: { name?: string; when?: Plan; covers?: string[] }): Minimum',
  params: [
    { name: 'amount', type: 'number', doc: 'USD per customer per month.' },
    {
      name: 'opts.covers',
      type: 'string[]',
      optional: true,
      default: 'every charge and fee that applies to the customer',
      doc: 'Names of the charges and fees counted toward the minimum.',
    },
    {
      name: 'opts.name',
      type: 'string',
      optional: true,
      doc: 'Line name; default `minimum`, plus ` (option=value, …)` with `when`.',
    },
    {
      name: 'opts.when',
      type: 'Plan',
      optional: true,
      doc: 'Applies only to customers whose plan matches every listed option.',
    },
  ],
  returns: "A `Minimum`; put it in the book's `prices`.",
  guidance: `
- The line's amount is \`max(0, amount − covered)\`, where \`covered\` sums the covered charges after discounts and the covered fees.
- Evaluated per customer, after charges, discounts and fees. Minimums don't count each other.
- \`covers\` must name elements in the book (checked by \`priceBook\`). Naming a discount or another minimum passes that check but adds nothing to \`covered\`.
- The top-up belongs to no meter.`,
  examples: [
    `import { minimum } from 'pricesim'

const floor = minimum(50)
const plFloor = minimum(100, {
  when: { network: 'privatelink' },
  name: 'privatelink minimum',
  covers: ['privatelink transfer', 'privatelink attachment'],
})`,
  ],
  seeAlso: ['priceBook', 'fee', 'charge'],
  guide: 'revenue',
})

/** A fraction off the covered charges, e.g. for a commitment. */
export const discount = (
  fraction: number,
  opts: { readonly name?: string; readonly when?: Plan; readonly covers?: readonly string[] } = {},
): Discount => {
  if (!(fraction >= 0 && fraction <= 1)) throw new Error(`discount: fraction must be in [0, 1], got ${fraction}`)
  return { kind: 'discount', fraction, ...opts }
}

doc({
  name: 'discount',
  kind: 'function',
  module: 'pricesim',
  summary: 'A price element: a fraction off the covered charges, e.g. for a commitment.',
  signature: 'discount(fraction: number, opts?: { name?: string; when?: Plan; covers?: string[] }): Discount',
  params: [
    { name: 'fraction', type: 'number', doc: 'Fraction off, 0–1 (0.2 = 20% off). Throws outside [0, 1].' },
    {
      name: 'opts.covers',
      type: 'string[]',
      optional: true,
      default: 'every charge that applies to the customer',
      doc: 'Names of the charges it applies to.',
    },
    {
      name: 'opts.name',
      type: 'string',
      optional: true,
      doc: 'Line name; default `discount`, plus ` (option=value, …)` with `when`.',
    },
    {
      name: 'opts.when',
      type: 'Plan',
      optional: true,
      doc: 'Applies only to customers whose plan matches every listed option.',
    },
  ],
  returns: "A `Discount`; put it in the book's `prices`.",
  guidance: `
- Applies to charges only, never to fees or minimums. Naming a fee in \`covers\` passes validation but has no effect.
- The discount line is negative; each covered charge line shows its \`net\` after discounts.
- Several discounts on one charge compound, in the order they appear in \`prices\` (0.2 then 0.1 is 28% off, not 30%).`,
  examples: [
    `import { discount } from 'pricesim'

const committed = discount(0.2, { when: { term: 'annual' }, name: 'annual commitment', covers: ['transferGB'] })`,
  ],
  seeAlso: ['priceBook', 'charge'],
  guide: 'revenue',
})

export interface PriceBook {
  readonly name: string
  readonly meters: Readonly<Record<string, Meter>>
  readonly options: Options
  readonly prices: readonly PriceElement[]
  /** margin per meter: costs no meter covers as an 'unallocated' line (default), or spread over meters */
  readonly allocate: 'unallocated' | 'proportional'
}

/** The name a price element reports under. */
export const elementName = (e: PriceElement): string => {
  if (e.name) return e.name
  const cond = e.when
    ? ` (${Object.entries(e.when)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')})`
    : ''
  switch (e.kind) {
    case 'charge':
      return `${e.meter}${cond}`
    case 'fee':
      return `fee${cond}`
    case 'minimum':
      return `minimum${cond}`
    case 'discount':
      return `discount${cond}`
  }
}

doc({
  name: 'elementName',
  kind: 'function',
  module: 'pricesim',
  summary: 'The name a price element reports under in the bill, and that `covers` refers to.',
  signature: 'elementName(e: PriceElement): string',
  returns:
    "`e.name` if set; otherwise the meter name (charges) or `fee` / `minimum` / `discount`, followed by ` (option=value, …)` when the element has `when`. For example `charge('gb', 1, { when: { tier: 'pro' } })` is named `gb (tier=pro)`.",
  seeAlso: ['priceBook'],
  guide: 'revenue',
})

/**
 * Define a price book against a root node; meters are type-checked against its request types and gauges, and
 * charges against the meters.
 */
export const priceBook = <
  R extends Record<string, RequestDef<any>>,
  G extends Record<string, GaugeDef>,
  M extends Record<string, Meter>,
  const O extends Options = {},
>(
  _root: Callable<R, G>,
  spec: {
    readonly name?: string
    readonly meters: (m: MeterBuilder<R, G>) => M
    readonly options?: O
    readonly prices: readonly PriceElement<keyof M & string>[]
    readonly allocate?: 'unallocated' | 'proportional'
  },
): PriceBook => {
  const meters = spec.meters(meterBuilder as MeterBuilder<R, G>)
  const options: Options = spec.options ?? {}
  for (const [k, o] of Object.entries(options)) {
    if (!o.values.includes(o.default)) throw new Error(`priceBook: option '${k}' default '${o.default}' is not a value`)
  }
  const names = new Set<string>()
  for (const e of spec.prices) {
    const n = elementName(e)
    if (names.has(n)) throw new Error(`priceBook: two price elements are named '${n}'; give one a name`)
    names.add(n)
    if (e.kind === 'charge' && !meters[e.meter]) throw new Error(`priceBook: charge on unknown meter '${e.meter}'`)
    for (const [k, v] of Object.entries(e.when ?? {})) {
      const o = options[k]
      if (!o) throw new Error(`priceBook: '${n}' is conditioned on unknown option '${k}'`)
      if (!o.values.includes(v)) throw new Error(`priceBook: '${n}': '${v}' is not a value of option '${k}'`)
    }
  }
  for (const e of spec.prices) {
    if ((e.kind === 'minimum' || e.kind === 'discount') && e.covers) {
      for (const c of e.covers) {
        if (!names.has(c)) throw new Error(`priceBook: '${elementName(e)}' covers unknown element '${c}'`)
      }
    }
  }
  return {
    name: spec.name ?? 'price book',
    meters,
    options,
    prices: spec.prices,
    allocate: spec.allocate ?? 'unallocated',
  }
}

doc({
  name: 'priceBook',
  kind: 'function',
  module: 'pricesim',
  summary: "What the provider charges its customers: meters over the root's traffic, and prices on them.",
  signature:
    'priceBook(root, spec: { name?: string; meters: (m: MeterBuilder) => Record<string, Meter>; options?: Options; prices: PriceElement[]; allocate?: "unallocated" | "proportional" }): PriceBook',
  params: [
    {
      name: 'root',
      type: 'Callable',
      doc: "The scenario's root node. Only used for types: meters are checked against its request types and gauges.",
    },
    {
      name: 'spec.name',
      type: 'string',
      optional: true,
      default: "'price book'",
      doc: 'Shown in results and CLI output.',
    },
    {
      name: 'spec.meters',
      type: '(m: MeterBuilder) => Record<string, Meter>',
      doc: "Billable quantities, by name. `m.requests({ <rootRequest>: (r) => qty }, unit)` for a quantity per request from its attributes; `m.gauge(<rootGauge>, unit, { costFrom? })` for a gauge's level × time.",
    },
    {
      name: 'spec.options',
      type: 'Record<string, { values: string[]; default: string }>',
      optional: true,
      doc: "Customer choices, e.g. `{ network: { values: ['public', 'privatelink'], default: 'public' } }`. The default must be one of the values.",
    },
    {
      name: 'spec.prices',
      type: 'PriceElement[]',
      doc: '`charge`, `fee`, `minimum` and `discount` elements. Names must be unique; charges must name a meter.',
    },
    {
      name: 'spec.allocate',
      type: "'unallocated' | 'proportional'",
      optional: true,
      default: "'unallocated'",
      doc: 'Where provider cost that no meter claims goes in per-meter margin: its own `unallocated` figure, or spread over the meters.',
    },
  ],
  returns:
    "A `PriceBook`. Pass it as a scenario's `priceBook`; `evaluate(scenario).revenue` then holds bill lines and margin in total, per meter and per customer, and `pricesim eval` prints them.",
  guidance: `
- **Plans.** A single-workload scenario takes \`plan\`; in a multi-tenant scenario each tenant has its own \`plan\`. Options a plan leaves out take their default; an unknown option or value throws when the scenario is evaluated.
- **Request meters** (\`m.requests\`): the monthly quantity is Σ (request rate × per-request quantity) over the workload period, scaled to a 730-hour month, in \`unit\` (a rate of 1 per \`unit\`: \`u.GB\` reports GB, \`u.one\` a plain count). Distribution-valued attributes are averaged by Monte Carlo with the workload's \`samples\` and seed, the same draws the cost side uses, so \`ceil(…)\` of a distribution is metered correctly.
- **Gauge meters** (\`m.gauge\`): the gauge level integrated over time, in a level × time unit, e.g. \`u.count.mul(u.month)\` for item-months or \`u.GB.mul(u.month)\` for a byte gauge.
- **Billing is per customer:** charges (tiers on the customer's own quantity), then discounts on charges, then fees, then minimum top-ups. See \`charge\`, \`discount\`, \`fee\`, \`minimum\`.
- **Margin is against the provider's cost only**: cost priced to the scenario's \`account\` (default \`'provider'\`). Nodes billed to another account (\`account: 'customer'\`) are excluded. A customer's cost is its own used cost plus a share of idle and fixed cost in proportion to its used cost (equal shares if nobody has used cost).
- **Per-meter cost.** A request meter claims the used cost under the root requests it lists. A gauge meter claims cost under root gauges whose path contains a gauge (or \`gaugeUse\` resource) named in \`costFrom\`. Without \`costFrom\`, a book's **only** gauge meter claims all gauge-driven cost; with several gauge meters, each claims its own gauge name, which is usually not on the path (when the root maps \`files\` to a bucket's \`stored\`, the cost is found under \`stored\`), so give each one \`costFrom\`. Names match anywhere below the root, not per node.
- A cost claimed by several meters (e.g. write units and GB on the same request) is split in proportion to those meters' revenue, or evenly if they have none.
- **\`allocate\`:** with \`'unallocated'\`, idle, fixed and unclaimed used cost are reported as \`unallocated\` (per customer and in total). With \`'proportional'\` they are spread over the meters in proportion to each meter's claimed cost (and stay unallocated if no meter claimed any).
- Fee and minimum revenue belongs to no meter: per-meter revenue is charges after discounts.
- \`priceBook\` throws on a charge on an unknown meter, duplicate element names, a \`when\` on an unknown option or value, \`covers\` naming an unknown element, or an option default that is not one of its values.`,
  examples: [
    `import { ceil, charge, discount, fee, gauge, minimum, priceBook, q, request, service, tiered, u } from 'pricesim'

const api = service('api', {
  gauges: { widgets: gauge(u.count) },
  requests: () => ({
    put: request({ bytes: u.byte }, () => ({})),
    get: request({ bytes: u.byte }, () => ({})),
  }),
})

export const prices = priceBook(api, {
  name: 'list prices',
  meters: (m) => ({
    // one write unit per started KiB
    writeUnits: m.requests({ put: (r) => ceil(r.bytes.div(q(1, u.KiB))) }, u.one),
    transferGB: m.requests({ put: (r) => r.bytes, get: (r) => r.bytes }, u.GB),
    widgetMonths: m.gauge('widgets', u.count.mul(u.month)),
  }),
  options: {
    network: { values: ['public', 'privatelink'], default: 'public' },
    term: { values: ['monthly', 'annual'], default: 'monthly' },
  },
  prices: [
    charge('writeUnits', 1 / 1e6),
    charge(
      'transferGB',
      tiered([
        { upTo: 10_000, rate: 0.05 },
        { upTo: null, rate: 0.03 },
      ]),
    ),
    charge('transferGB', 0.03, { when: { network: 'privatelink' }, name: 'privatelink transfer' }),
    charge('widgetMonths', 0.2),
    fee(50, { when: { network: 'privatelink' }, name: 'privatelink attachment' }),
    discount(0.2, { when: { term: 'annual' }, name: 'annual commitment' }),
    minimum(100),
  ],
})`,
    `import { evaluate, priceBook, charge, gauge, pricing, q, request, scenario, series, service, u, workload } from 'pricesim'

const api = service('api', {
  gauges: { widgets: gauge(u.count) },
  requests: () => ({ put: request({ bytes: u.byte }, () => ({})) }),
})
const book = priceBook(api, {
  meters: (m) => ({ gb: m.requests({ put: (r) => r.bytes }, u.GB) }),
  options: { support: { values: ['standard', 'premium'], default: 'standard' } },
  prices: [charge('gb', 0.05)],
})
const load = (perSecond: number) =>
  workload(api, {
    requests: { put: { rate: series.constant(q(perSecond, u.req.div(u.s))), attrs: { bytes: q(2000, u.byte) } } },
  })

const r = evaluate(
  scenario({
    name: 'priced',
    root: api,
    tenants: [
      { id: 'small', workload: load(10) },
      { id: 'large', workload: load(500), plan: { support: 'premium' } },
    ],
    pricing: pricing(),
    priceBook: book,
  }),
)
console.log(r.revenue?.margin, r.revenue?.customers.map((c) => [c.id, c.marginRate]))`,
  ],
  seeAlso: ['charge', 'fee', 'minimum', 'discount', 'scenario', 'evaluate', 'eval'],
  guide: 'revenue',
})

/** A plan's value for every option (defaults filled in); rejects unknown options and values. */
export const resolvePlan = (book: PriceBook, plan: Plan = {}): Plan => {
  for (const [k, v] of Object.entries(plan)) {
    const o = book.options[k]
    if (!o) throw new Error(`plan: unknown option '${k}' (price book '${book.name}')`)
    if (!o.values.includes(v)) throw new Error(`plan: '${v}' is not a value of option '${k}'`)
  }
  return Object.fromEntries(Object.entries(book.options).map(([k, o]) => [k, plan[k] ?? o.default]))
}

export const applies = (e: PriceElement, plan: Plan): boolean =>
  Object.entries(e.when ?? {}).every(([k, v]) => plan[k] === v)

docs([
  {
    name: 'resolvePlan',
    kind: 'function',
    module: 'pricesim',
    summary:
      "A customer's plan with every option filled in (defaults for the missing ones); throws on unknown options or values.",
    internal: true,
  },
  {
    name: 'applies',
    kind: 'function',
    module: 'pricesim',
    summary: "Whether a price element's `when` matches a resolved plan.",
    internal: true,
  },
])
