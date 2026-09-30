---
title: Price books and margin
summary: Meters, charges, fees, minimums, discounts, plans; revenue and margin per customer.
order: 9
---

A price book says what **you** charge. It's defined against the root node, like a workload, and attached to a scenario, so one model can be priced under several books.

```ts
import { freeTier, pricing, q, scenario, series, tiered, u, workload } from 'pricesim'
import { gauge, request, service } from 'pricesim/model'
import { charge, discount, fee, minimum, priceBook } from 'pricesim'

export const api = service('api', {
  gauges: { streams: gauge(u.count) },
  requests: () => ({ write: request({ bytes: u.byte }, () => ({})), read: request({ bytes: u.byte }, () => ({})) }),
})

export const prices = priceBook(api, {
  name: 'list prices',
  meters: (m) => ({
    writeGB: m.requests({ write: (r) => r.bytes }, u.GB),
    readGB: m.requests({ read: (r) => r.bytes }, u.GB),
    streamHours: m.gauge('streams', u.count.mul(u.hour)),
  }),
  options: { network: { values: ['public', 'privatelink'], default: 'public' } },
  prices: [
    charge(
      'writeGB',
      tiered([
        { upTo: 10_000, rate: 0.05 },
        { upTo: null, rate: 0.03 },
      ]),
    ),
    charge('readGB', 0.02),
    // the same meter, a surcharge for one option
    charge('readGB', 0.01, { when: { network: 'privatelink' }, name: 'privatelink transfer' }),
    charge('streamHours', freeTier(1_000, 0.004)),
    fee(100, { when: { network: 'privatelink' }, name: 'privatelink endpoint' }),
    minimum(50),
    discount(0.1),
  ],
})

const w = workload(api, {
  requests: {
    write: { rate: series.constant(q(100, u.req.div(u.s))), attrs: { bytes: q(4, u.KB) } },
    read: { rate: series.constant(q(250, u.req.div(u.s))), attrs: { bytes: q(4, u.KB) } },
  },
  gauges: { streams: q(40, u.count) },
})

export default scenario({
  name: 'priced',
  root: api,
  workload: w,
  pricing: pricing(),
  priceBook: prices,
  plan: { network: 'privatelink' },
})
```

## Elements

- **Meters** turn the root's traffic into billable quantities: `m.requests({ <request>: (r) => quantity }, unit)` per request, from its attributes (e.g. `ceil(r.bytes.div(q(5, u.KiB)))` for 5 KiB request units); `m.gauge(name, unitTimesTime, { costFrom? })` for level × time.
- **Prices:** `charge(meter, schedule)` (flat, tiered, free tier; several charges can share a meter), `fee(amount)` per customer per month, `minimum(amount)` (top-up), `discount(fraction)`. Any of them can be conditioned with `when: { option: value }`.
- **Options and plans:** `options` declares customer choices; a scenario's `plan` (or each tenant's) picks them. **Tiers, minimums and discounts apply per customer.**

## Revenue and margin

`evaluate(s).revenue` (and `pricesim eval`) gives revenue, cost and margin in total, per meter and per customer.

- Margin is against the **provider's** cost only; charges on other accounts (`account: 'customer'`) are excluded.
- A request meter's cost is the cost under its requests. A book's only gauge meter gets all gauge-driven cost; with several gauge meters, give each `costFrom`: the gauges (and `gaugeUse` resources) its gauge becomes further down the graph (e.g. a `streams` meter whose cost is `['streams', 'memory']`).
- Cost no meter covers (idle, fixed, unmetered requests) is the `unallocated` line; `allocate: 'proportional'` spreads it over the meters.
- For explicit price tables that you tune, keep the numbers in one exported object and build the book from it; don't scale arrays of multipliers.

Details: `pricesim describe priceBook`, `pricesim describe charge`, `pricesim describe minimum`, `pricesim describe computeRevenue`.
