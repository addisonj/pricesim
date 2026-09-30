---
title: Analysing a model
summary: Which command or function answers which question; reading results.
order: 10
---

| Question                                             | CLI                                                         | Code                                   |
| ---------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| What does this cost per month, and where does it go? | `pricesim eval model.ts`                                    | `evaluate(scenario)`                   |
| What does one request of each type cost?             | `pricesim unit-cost model.ts --rate 100`                    | `unitCosts(scenario, { rate })`        |
| How does cost scale with X? (formula)                | `pricesim closed model.ts --mode relaxed --keep …`          | `closedForm(scenario, { mode, keep })` |
| How does cost change across a range? (numbers)       | `pricesim sweep model.ts --var rate.x=10..1000:log:8 --csv` | `sweep(scenario, vars)`                |
| How far does a fixed deployment go?                  | `pricesim capacity model.ts --fix pool=6`                   | `capacity(scenario, { fix })`          |
| What's our margin, per customer?                     | `pricesim eval` on a scenario with a price book             | `evaluate(s).revenue`                  |

Each command has the details: `pricesim <command> --describe`.

## Reading a result

- `total = used + idle + fixed`. Look at idle first on small workloads (minimum sizes dominate), and at the largest used line on large ones.
- The tree follows the call graph: root → request type (and `gauges`) → services and offerings → billing dimensions. Cross-AZ transfer sits under `cross-az` in the request that declared the edge.
- `dimensions` (JSON) has usage, list cost, cost and effective rate per billing dimension; compare the effective rate with the list rate to see tiers and discounts at work.
- `pools` has each pool's count, `binding` resource and per-resource peak, mean and capacity.

## Scripts over scenarios

When a question needs many scenarios (segments by size, price variants, several seeds), write a small script that builds scenarios in a loop and calls `evaluate()`; print a markdown table. Keep reusable pieces (the root service, the workload shape as a function of size) in their own module and import them from both the model files and the scripts.

```ts
import { dimension, evaluate, pricing, q, scenario, series, u, workload } from 'pricesim'
import { bill, request, service } from 'pricesim/model'

const calls = dimension('example.calls', u.req, 0.2e-6) // $0.20 per million
export const api = service('api', {
  requests: () => ({ call: request({}, () => ({ bill: [bill(calls, q(1, u.req))] })) }),
})

for (const rps of [10, 100, 1000]) {
  const w = workload(api, { requests: { call: { rate: series.constant(q(rps, u.req.div(u.s))), attrs: {} } } })
  const r = evaluate(scenario({ name: `api-${rps}`, root: api, workload: w, pricing: pricing() }))
  console.log(`| ${rps} req/s | $${r.total.toFixed(0)} |`)
}
```

Details: `pricesim describe evaluate`, `pricesim describe unitCosts`, `pricesim describe closedForm`, `pricesim describe sweep`, `pricesim describe capacity`.
