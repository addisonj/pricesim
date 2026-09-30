---
title: Billing dimensions and offerings
summary: Price lines (flat, tiered, free tier), offerings of your own, pricing contexts and discounts.
order: 4
---

## Billing dimensions

A billing dimension is one line of a bill: an id, a usage unit, a price schedule, and a family (for discounts).

```ts
import { dimension, freeTier, tiered, u } from 'pricesim'

// flat: USD per usage unit
export const requests = dimension('example.queue.requests', u.req, 0.4e-6)
// free tier: the first 1M requests free, then $0.40 per million
export const sends = dimension('example.queue.sends', u.req, freeTier(1e6, 0.4e-6))
// volume tiers over the month's pooled usage (upTo is cumulative, in usage units; null = no limit)
export const storage = dimension(
  'example.storage',
  u.GB.mul(u.month),
  tiered([
    { upTo: 50_000, rate: 0.023 },
    { upTo: null, rate: 0.022 },
  ]),
  { family: 'example.storage' },
)
```

- Rates are **USD per one usage unit** (per request, per GB-month, per hour).
- Tiers apply to the **scenario's pooled monthly usage** of the dimension across every consumer (per paying account), and the blended rate is allocated back in proportion to usage.
- The family defaults to the first two segments of the id (`aws.ec2.m7g.xlarge.hours` → `aws.ec2`).
- **Define each dimension once and share the object.** Two objects with the same id are an error.
- Give catalog-style dimensions a `source: { url, retrieved }` so readers can check the price.

## Offerings

An offering is a node whose request types `bill` dimensions, and whose gauges can be billed as level × time. Write one for any product the catalog doesn't have (a SaaS dependency, a vendor quote):

```ts
import { ceil, dimension, freeTier, q, u } from 'pricesim'
import { bill, gauge, offering, request } from 'pricesim/model'

const sends = dimension('example.queue.sends', u.req, freeTier(1e6, 0.4e-6))
const retainedGBMonths = dimension('example.queue.retained', u.GB.mul(u.month), 0.1)

export const queue = offering('queue:events', {
  gauges: { retained: gauge(u.byte, { billAs: retainedGBMonths }) },
  requests: () => ({
    // billed per 64 KB chunk
    send: request({ bytes: u.byte }, (r) => ({ bill: [bill(sends, ceil(r.bytes.div(q(64, u.KB))).mul(q(1, u.req)))] })),
  }),
})
```

A gauge's `billAs` dimension must have the gauge's unit × time (bytes → GB-month, count → count-hour).

## Pricing context and discounts

`pricing({ region, familyDiscounts, negotiatedDiscount, regionMultipliers })` goes on the scenario.

- `familyDiscounts` are fractions off by family, matched by **longest prefix**: `{ 'aws.ec2': 0.28, 'aws.transfer.inter-az': 0.5 }`.
- `negotiatedDiscount` (EDP-style) applies after family discounts, to everything.
- The region multiplier scales every rate (us-east-1 = 1.0); unknown regions are an error unless you pass `regionMultipliers`.
- Commitment discounts for EC2 come from the price list: `ec2CommitmentDiscount('m7g.2xlarge', 'computeSavingsPlan1yNoUpfront')` (`pricesim describe ec2CommitmentDiscount`).

Details: `pricesim describe dimension`, `pricesim describe tiered`, `pricesim describe offering`, `pricesim describe pricing`.
