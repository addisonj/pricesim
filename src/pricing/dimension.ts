// Billing dimensions and price schedules (DESIGN.md §5.1). Rates are USD per one `usageUnit`.
import type { Unit } from '../core/units.ts'
import { doc, docs } from '../docs/registry.ts'

export type PriceSchedule =
  | { readonly kind: 'flat'; readonly rate: number }
  /** tiers apply to the pooled usage of a billing period; `upTo` is cumulative, in usage units */
  | { readonly kind: 'tiered'; readonly tiers: readonly { readonly upTo: number | null; readonly rate: number }[] }
  | { readonly kind: 'freeTier'; readonly free: number; readonly then: PriceSchedule }

export interface Source {
  readonly url: string
  /** date the price was read, YYYY-MM-DD */
  readonly retrieved: string
  readonly note?: string
}

export interface BillingDimension<D = any> {
  readonly id: string
  readonly usageUnit: Unit<D>
  readonly schedule: PriceSchedule
  /** groups dimensions for commitments/discounts, e.g. 'aws.ec2.compute' */
  readonly family: string
  readonly source?: Source
}

export const dimension = <D>(
  id: string,
  usageUnit: Unit<D>,
  schedule: PriceSchedule | number,
  opts: { family?: string; source?: Source } = {},
): BillingDimension<D> => ({
  id,
  usageUnit,
  schedule: typeof schedule === 'number' ? { kind: 'flat', rate: schedule } : schedule,
  family: opts.family ?? id.split('.').slice(0, 2).join('.'),
  ...(opts.source ? { source: opts.source } : {}),
})

doc({
  name: 'dimension',
  kind: 'function',
  module: 'pricesim',
  summary:
    'A billing dimension: one line of a cloud bill, with an id, a usage unit, a price schedule and a discount family.',
  signature:
    'dimension(id: string, usageUnit: Unit<D>, schedule: PriceSchedule | number, opts?: { family?: string; source?: Source }): BillingDimension<D>',
  params: [
    {
      name: 'id',
      type: 'string',
      doc: "Dot-separated, unique per model, e.g. 'example.queue.requests'. Results and reports list costs by it.",
    },
    {
      name: 'usageUnit',
      type: 'Unit<D>',
      doc: 'What the rate is per: `u.req`, `u.GB`, `u.GB.mul(u.month)` (storage), `u.hour` (instance-hours). Usage billed to it must have its dimension.',
    },
    {
      name: 'schedule',
      type: 'PriceSchedule | number',
      doc: 'A number is a flat rate in USD per one `usageUnit`; or `tiered(…)` / `freeTier(…)`.',
    },
    {
      name: 'opts.family',
      type: 'string',
      optional: true,
      default: 'the first two segments of `id`',
      doc: "The group `pricing({ familyDiscounts })` matches, by dot-separated prefix: 'aws.ec2.compute' is discounted by an 'aws.ec2' or an 'aws' entry.",
    },
    {
      name: 'opts.source',
      type: 'Source',
      optional: true,
      doc: 'Where the price came from: `{ url, retrieved, note? }`.',
    },
  ],
  returns:
    'A `BillingDimension<D>`. Charge it from a request with `bill(dim, usage)`, or from a gauge level with `gauge(unit, { billAs: dim })`.',
  guidance: `
- **Rates are USD per one \`usageUnit\`.** Usage is converted to that unit before pricing, so \`dimension('x', u.GB, 0.09)\` is $0.09 per decimal GB whatever unit the usage was written in. Pick the unit the price list uses.
- **Storage** is priced per GB-month: use \`u.GB.mul(u.month)\` and bill it from a gauge (a level held over time), not per request.
- Schedules apply per billing month (usage over the evaluated period scaled to a 730-hour month), pooled across all consumers of the dimension within an account. The blended cost is allocated back in proportion to usage.
- The final cost is list cost × region multiplier × (1 − family discount) × (1 − negotiated discount); see \`pricing\`.
- Two different dimension objects with the same id in one account make evaluation throw; define each dimension once and share it.`,
  examples: [
    `import { dimension, freeTier, q, u } from 'pricesim'
import { bill, offering, request } from 'pricesim/model'

// first 1M requests a month free, then $0.40 per million
const queueRequests = dimension('example.queue.requests', u.req, freeTier(1e6, 0.4e-6), { family: 'example.queue' })

export const queue = offering('queue:jobs', {
  requests: () => ({
    send: request({}, () => ({ bill: [bill(queueRequests, q(1, u.req))] })),
  }),
})`,
    `import { dimension, u } from 'pricesim'

const storage = dimension('example.store.storage', u.GB.mul(u.month), 0.023, {
  source: { url: 'https://example.com/pricing', retrieved: '2026-09-01' },
})`,
  ],
  seeAlso: ['tiered', 'freeTier', 'pricing', 'bill', 'gauge', 'offering'],
  guide: 'offerings',
})

export const tiered = (tiers: readonly { upTo: number | null; rate: number }[]): PriceSchedule => ({
  kind: 'tiered',
  tiers,
})
export const freeTier = (free: number, then: PriceSchedule | number): PriceSchedule => ({
  kind: 'freeTier',
  free,
  then: typeof then === 'number' ? { kind: 'flat', rate: then } : then,
})

doc({
  name: 'tiered',
  kind: 'function',
  module: 'pricesim',
  summary:
    "A volume-tiered price schedule: each tier's rate applies to the usage that falls within it (like S3 storage or data transfer out).",
  signature: 'tiered(tiers: { upTo: number | null; rate: number }[]): PriceSchedule',
  params: [
    {
      name: 'tiers',
      type: '{ upTo: number | null; rate: number }[]',
      doc: '`upTo` is the cumulative top of the tier in usage units per month (`null` = no limit); `rate` is USD per usage unit. In ascending order.',
    },
  ],
  returns: 'A `PriceSchedule` to pass to `dimension` (or to `freeTier` as `then`).',
  guidance: `
- Graduated, not all-units: with tiers 50,000 @ 0.023 then 0.022, 100,000 units cost 50,000 × 0.023 + 50,000 × 0.022.
- Tiers apply to the month's usage pooled across the account (see \`dimension\`), so a tiered dimension shared by several services gets one blended rate.
- End with \`upTo: null\`. Usage beyond the last finite \`upTo\` is not charged.`,
  examples: [
    `import { dimension, tiered, u } from 'pricesim'

const storage = dimension(
  'example.store.storage',
  u.GB.mul(u.month),
  tiered([
    { upTo: 50_000, rate: 0.023 },
    { upTo: 500_000, rate: 0.022 },
    { upTo: null, rate: 0.021 },
  ]),
)`,
  ],
  seeAlso: ['dimension', 'freeTier', 'scheduleCost'],
  guide: 'offerings',
})

doc({
  name: 'freeTier',
  kind: 'function',
  module: 'pricesim',
  summary: 'A schedule whose first `free` usage units each month cost nothing, then `then` applies to the rest.',
  signature: 'freeTier(free: number, then: PriceSchedule | number): PriceSchedule',
  params: [
    { name: 'free', type: 'number', doc: "Free usage per month, in the dimension's usage units." },
    {
      name: 'then',
      type: 'PriceSchedule | number',
      doc: 'The schedule for usage above `free`: a flat rate in USD per usage unit, or `tiered(…)` (whose `upTo` then counts from the end of the free allowance).',
    },
  ],
  returns: 'A `PriceSchedule` to pass to `dimension`.',
  guidance: `
- \`freeTier(25, 0.25)\`: 10 units cost 0; 125 units cost 100 × 0.25 = 25.
- Like tiers, the allowance applies to the month's usage pooled across the account, not per consumer.`,
  examples: [
    `import { dimension, freeTier, tiered, u } from 'pricesim'

const egress = dimension(
  'example.egress',
  u.GB,
  freeTier(
    100,
    tiered([
      { upTo: 10_240, rate: 0.09 },
      { upTo: null, rate: 0.085 },
    ]),
  ),
)`,
  ],
  seeAlso: ['dimension', 'tiered'],
  guide: 'offerings',
})

/** Cost in USD of `usage` (in usage units) under a schedule. */
export const scheduleCost = (s: PriceSchedule, usage: number): number => {
  switch (s.kind) {
    case 'flat':
      return usage * s.rate
    case 'freeTier':
      return scheduleCost(s.then, Math.max(0, usage - s.free))
    case 'tiered': {
      let cost = 0
      let prev = 0
      for (const t of s.tiers) {
        const top = t.upTo ?? Infinity
        if (usage <= prev) break
        cost += (Math.min(usage, top) - prev) * t.rate
        prev = top
      }
      return cost
    }
  }
}

docs([
  {
    name: 'scheduleCost',
    kind: 'function',
    module: 'pricesim',
    summary: 'List cost in USD of `usage` usage units under a schedule, before region multiplier and discounts.',
    signature: 'scheduleCost(s: PriceSchedule, usage: number): number',
    guidance: '- The engine calls it with monthly usage; call it yourself to check a schedule.',
    examples: [
      `import { freeTier, scheduleCost } from 'pricesim'

scheduleCost(freeTier(25, 0.25), 125) // 25`,
    ],
    seeAlso: ['tiered', 'freeTier'],
    guide: 'offerings',
  },
  {
    name: 'BillingDimension',
    kind: 'type',
    module: 'pricesim',
    summary: 'A billing dimension: `{ id, usageUnit, schedule, family, source? }`, as made by `dimension`.',
    seeAlso: ['dimension'],
    guide: 'offerings',
  },
  {
    name: 'PriceSchedule',
    kind: 'type',
    module: 'pricesim',
    summary:
      "How a dimension's usage is priced: `{ kind: 'flat', rate }`, `{ kind: 'tiered', tiers }` or `{ kind: 'freeTier', free, then }`; rates in USD per usage unit.",
    seeAlso: ['tiered', 'freeTier'],
    guide: 'offerings',
  },
  {
    name: 'Source',
    kind: 'type',
    module: 'pricesim',
    summary: "Where a price came from: `{ url, retrieved: 'YYYY-MM-DD', note? }`.",
    seeAlso: ['dimension'],
    guide: 'offerings',
  },
])
