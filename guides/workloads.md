---
title: Workloads and scenarios
summary: Workloads, series, scenarios, tenants and distributions.
order: 8
---

## Workloads

A workload is written against the root node, so request names, attributes and gauges are type-checked. Per root request type it gives a rate **series** and the attributes.

```ts
import { dist, q, retained, scenario, series, u, workload, pricing } from 'pricesim'
import { gauge, request, service } from 'pricesim/model'
import { interAz } from 'pricesim/aws'

const perSecond = u.req.div(u.s)
export const api = service('api', {
  gauges: { stored: gauge(u.byte) },
  requests: () => ({ write: request({ bytes: u.byte }, () => ({})) }),
})

export const typical = workload(api, {
  requests: {
    write: {
      rate: series.diurnal({ mean: q(200, perSecond), peakToMean: 1.6 }),
      // a mix of sizes: sampled (seeded), so ceil() and other non-linear costs come out right
      attrs: { bytes: dist.lognormal({ median: q(1, u.KB), p99: q(64, u.KB) }) },
    },
  },
  // 7 days of writes retained, derived from the mean write rate (so sweeps move it too)
  gauges: ({ rate }) => ({ stored: retained({ rate: rate.write.mul(q(1, u.KB.div(u.req))), retention: q(7, u.day) }) }),
})

export default scenario({ name: 'api', root: api, workload: typical, pricing: pricing(), interAz })
```

- **Series:** `series.constant(rate)`, `series.diurnal({ mean, peakToMean, peakHour? })` (1 ≤ peakToMean ≤ 2), `series.fromArray(values, stepSeconds)`.
- **Attributes:** a fixed `Expr`, or a distribution: `dist.fixed`, `dist.uniform`, `dist.empirical([{ value, weight }])`, `dist.lognormal({ median, p99 })`. `samples` (default 64) and `seed` (default 1) control the sampling.
- **Gauges:** constants, or a function of `{ rate, time }`: `rate.<request>` is the mean rate over the period, `time` the elapsed seconds. `retained({ rate, retention?, ageAtStart? })` gives a filled retention window, or data that keeps accumulating.
- **Other options:** `params` (override `param(…)`s used in the model's expressions), `period` and `step` (`Expr<s>`; defaults 730 h and 1 h), `peak: 'max' | { percentile: 99 }`.
- Series and distribution values are evaluated when built, so a `param(…)` inside `series.*` or `dist.*` uses its default, not the workload's `params`. Write rates as functions of plain numbers instead.

## Scenarios

`scenario({ name, root, workload | tenants, pricing, interAz?, account?, priceBook?, plan? })`:

- `pricing`: region and discounts (`pricesim guide offerings`).
- `interAz`: required when any request declares network edges; `interAz` from `pricesim/aws`.
- `priceBook` and `plan`: what you charge (`pricesim guide revenue`).

## Tenants

Replace `workload` with `tenants: [{ id, workload, plan? }, …]` to put several customers on one deployment. Capacity is sized on their **combined** demand; `result.tenants` gives each tenant its used cost plus a share of idle and fixed in proportion to used cost. All tenants need the same period and step.

For a simulated customer base:

- `zipfTenants({ count, exponent?, seed?, make: ({ id, share, rng }) => workload(…) })`: a few large tenants and a long tail (`share`s sum to 1).
- `simulateTenants({ count, seed?, make: ({ id, index, rng }) => workload(…) })`: any distribution you draw from `rng` yourself (lognormal sizes are a better fit than Zipf when you need a tail of tiny customers).

Only `evaluate()` / `pricesim eval` support tenants; `unitCosts`, `closedForm`, `sweep` and `capacity` need a single workload (`withWorkload(scenario, w)` makes one).

Details: `pricesim describe workload`, `pricesim describe series`, `pricesim describe dist`, `pricesim describe retained`, `pricesim describe scenario`, `pricesim describe zipfTenants`.
