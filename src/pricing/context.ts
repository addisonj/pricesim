// Pricing context (DESIGN.md §5.5): region multiplier, per-family commitment discounts, negotiated discount.
import { doc, docs } from '../docs/registry.ts'

export interface PricingContext {
  readonly region: string
  /** multiplier applied to every rate in the region (us-east-1 = 1.0) */
  readonly regionMultiplier: number
  /** fractional discount per dimension family, e.g. { 'aws.ec2': 0.28 } for a 1-year Savings Plan */
  readonly familyDiscounts: Readonly<Record<string, number>>
  /** EDP-style discount applied after family discounts */
  readonly negotiatedDiscount: number
}

export const DEFAULT_REGION_MULTIPLIERS: Readonly<Record<string, number>> = {
  'us-east-1': 1.0,
  'us-east-2': 1.0,
  'us-west-2': 1.0,
  'eu-west-1': 1.1,
  'eu-central-1': 1.15,
  'ap-southeast-1': 1.3,
}

export const pricing = (
  opts: {
    region?: string
    regionMultipliers?: Readonly<Record<string, number>>
    familyDiscounts?: Readonly<Record<string, number>>
    negotiatedDiscount?: number
  } = {},
): PricingContext => {
  const region = opts.region ?? 'us-east-1'
  const multipliers = { ...DEFAULT_REGION_MULTIPLIERS, ...opts.regionMultipliers }
  const regionMultiplier = multipliers[region]
  if (regionMultiplier === undefined) throw new Error(`no region multiplier for '${region}'`)
  return {
    region,
    regionMultiplier,
    familyDiscounts: opts.familyDiscounts ?? {},
    negotiatedDiscount: opts.negotiatedDiscount ?? 0,
  }
}

doc({
  name: 'pricing',
  kind: 'function',
  module: 'pricesim',
  summary:
    "A pricing context for a scenario: the region's price multiplier, per-family discounts (commitments) and a negotiated discount.",
  signature:
    'pricing(opts?: { region?: string; regionMultipliers?: Record<string, number>; familyDiscounts?: Record<string, number>; negotiatedDiscount?: number }): PricingContext',
  params: [
    {
      name: 'opts.region',
      type: 'string',
      optional: true,
      default: "'us-east-1'",
      doc: 'Selects the multiplier; throws if neither `regionMultipliers` nor the defaults have it.',
    },
    {
      name: 'opts.regionMultipliers',
      type: 'Record<string, number>',
      optional: true,
      doc: 'Multipliers to add to or override `DEFAULT_REGION_MULTIPLIERS` (us-east-1 = 1.0).',
    },
    {
      name: 'opts.familyDiscounts',
      type: 'Record<string, number>',
      optional: true,
      default: '{}',
      doc: "Fractional discount (0.28 = 28% off) by dimension family prefix, e.g. `{ 'aws.ec2': 0.28 }` for a Savings Plan. The longest matching prefix wins.",
    },
    {
      name: 'opts.negotiatedDiscount',
      type: 'number',
      optional: true,
      default: '0',
      doc: 'An EDP-style fraction off everything, applied after family discounts.',
    },
  ],
  returns: "A `PricingContext`; pass it as a scenario's `pricing`.",
  guidance: `
- Every dimension's cost is list cost × region multiplier × (1 − family discount) × (1 − negotiated discount). Discounts compound; they don't add.
- **Region is one multiplier on every rate**, not per-service regional prices: catalog rates are us-east-1 list prices, and the defaults are rough (eu-west-1 1.1, eu-central-1 1.15, ap-southeast-1 1.3). Override them when accuracy matters.
- **Family discounts** match a dimension's \`family\` by dot-separated prefix (see \`familyDiscount\`). EC2 instance-hours are family 'aws.ec2.compute', so \`'aws.ec2'\` discounts them; \`ec2CommitmentDiscount\` from \`pricesim/aws\` gives realistic commitment fractions.
- The same usage can be re-priced under several contexts (list, Savings Plan, EDP) to compare them.`,
  examples: [
    `import { pricing } from 'pricesim'
import { ec2CommitmentDiscount } from 'pricesim/aws'

const list = pricing()
const committed = pricing({
  region: 'eu-west-1',
  familyDiscounts: {
    'aws.ec2': ec2CommitmentDiscount('m7g.2xlarge', 'computeSavingsPlan1yNoUpfront') ?? 0,
    'aws.transfer.inter-az': 0.4,
  },
  negotiatedDiscount: 0.05,
})`,
  ],
  seeAlso: ['familyDiscount', 'dimension', 'DEFAULT_REGION_MULTIPLIERS', 'scenario', 'ec2CommitmentDiscount'],
  guide: 'offerings',
})

/** Longest-prefix match of a dimension family against the configured discounts. */
export const familyDiscount = (ctx: PricingContext, family: string): number => {
  let best = 0
  let bestLen = -1
  for (const [prefix, d] of Object.entries(ctx.familyDiscounts)) {
    if ((family === prefix || family.startsWith(prefix + '.')) && prefix.length > bestLen) {
      best = d
      bestLen = prefix.length
    }
  }
  return best
}

docs([
  {
    name: 'familyDiscount',
    kind: 'function',
    module: 'pricesim',
    summary: 'The discount a context gives a dimension family: the longest configured prefix that matches it, else 0.',
    signature: 'familyDiscount(ctx: PricingContext, family: string): number',
    guidance: `
- A prefix matches the family itself or any family below it on a \`.\` boundary: \`'aws.ec2'\` matches \`'aws.ec2.compute'\` but not \`'aws.ec2x'\`.
- Only the most specific match applies; discounts at different levels don't stack. With \`{ 'aws.ec2': 0.2, 'aws.ec2.compute': 0.3 }\`, \`'aws.ec2.compute'\` gets 0.3 and \`'aws.ec2.other'\` 0.2.`,
    examples: [
      `import { familyDiscount, pricing } from 'pricesim'

const ctx = pricing({ familyDiscounts: { 'aws.transfer': 0.1, 'aws.transfer.inter-az': 0.4 } })
familyDiscount(ctx, 'aws.transfer.inter-az') // 0.4
familyDiscount(ctx, 'aws.transfer.internet') // 0.1
familyDiscount(ctx, 'aws.s3') // 0`,
    ],
    seeAlso: ['pricing', 'dimension'],
    guide: 'offerings',
  },
  {
    name: 'DEFAULT_REGION_MULTIPLIERS',
    kind: 'const',
    module: 'pricesim',
    summary:
      'Built-in region price multipliers: 1.0 for us-east-1, us-east-2 and us-west-2; eu-west-1 1.1, eu-central-1 1.15, ap-southeast-1 1.3.',
    guidance: '- Rough approximations; extend or override them with `pricing({ regionMultipliers })`.',
    seeAlso: ['pricing'],
    guide: 'offerings',
  },
  {
    name: 'PricingContext',
    kind: 'type',
    module: 'pricesim',
    summary: '`{ region, regionMultiplier, familyDiscounts, negotiatedDiscount }`, as made by `pricing`.',
    seeAlso: ['pricing'],
    guide: 'offerings',
  },
])
