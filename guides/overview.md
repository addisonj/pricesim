---
title: Overview
summary: What pricesim models, the pieces, and the order to learn them.
order: 1
---

pricesim answers "what does it cost us to run this, and what should we charge for it?" for software on cloud infrastructure. You describe the system as code (what each request does, what capacity it needs, which cloud products it bills) and a workload (how much of each request, over time). pricesim sizes the capacity at peak, prices every line of the bill, and folds the cost into a tree you can read top-down.

## The pieces

| Piece             | What it is                                                                       | Guide                                                |
| ----------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `Expr`, units     | Every quantity carries its unit, checked at compile time and at runtime          | `pricesim guide units`                               |
| Billing dimension | One line of a cloud bill: id, usage unit, price schedule                         | `pricesim guide offerings`                           |
| Offering          | A priced cloud product (a leaf): S3, a load balancer, a queue                    | `pricesim guide offerings`, `pricesim guide catalog` |
| Service           | Your code: request types that use capacity, call other nodes and bill dimensions | `pricesim guide services`                            |
| Pools             | Capacity: instance pools, Kubernetes node pools and pods                         | `pricesim guide capacity`                            |
| Workload          | Request rates over time, request attributes, gauge levels                        | `pricesim guide workloads`                           |
| Scenario          | Root node + workload (or tenants) + pricing context                              | `pricesim guide workloads`                           |
| Price book        | What _you_ charge: meters, charges, fees, plans; gives revenue and margin        | `pricesim guide revenue`                             |
| Analysis          | eval, unit-cost, closed form, sweep, capacity                                    | `pricesim guide analysis`                            |

Offerings and services are both _nodes_, and expose request types and gauges the same way, so services nest to any depth.

## How evaluation works

1. The workload drives the root node step by step (hourly by default, over a 730-hour month).
2. Each request's body expands into calls, capacity demand, billed usage and network edges, recursively.
3. Pools are sized for **peak** demand and held for the whole period, never below their minimum.
4. Usage is collected per billing dimension (a usage ledger), then priced: tiers, free tiers, region multiplier, discounts.
5. Costs fold into a tree: `total = used + idle + fixed`. _Used_ follows the call graph, _idle_ is provisioned but unused capacity, _fixed_ is time-based charges.

## Learning path

1. `pricesim guide model-file`: the skeleton of a runnable model.
2. `pricesim guide units`, then `services`, then `capacity`: enough to model a system.
3. `pricesim guide workloads`, then `analysis`: drive it and read the results.
4. `pricesim guide revenue`: once you want margins.
5. `pricesim guide pitfalls`: before trusting a number.

For any function: `pricesim api <word>` to find it, `pricesim describe <name>` for its parameters and examples. A worked example with real output is `docs/guide.md` in the repository (`examples/guide-example.ts`).
