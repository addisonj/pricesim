---
title: Services, requests and gauges
summary: Services, request types and calls, gauges, network edges, fixed charges, accounts.
order: 6
---

A service is your code. It declares its dependencies (`deps`), its capacity (`pools`), its gauges, and its request types. `requests` is a function of `{ deps, pools }`, so every call into a dependency is type-checked.

## Request bodies

A request type has typed attributes and a body. The body returns lists, all **per single request**:

| Field   | What it holds                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `use`   | Demand on capacity: `pools.x.cpu(cpuTime)`, `pools.x.network(bytes)`, `pools.x.ebsIops(ops)`, `pools.x.use('custom', amount)` |
| `calls` | Calls into dependencies: `deps.y.put({ bytes })`; `.times(0.3)` for "30% of requests", `.times(3)` for three calls            |
| `bill`  | Direct usage of a billing dimension: `bill(dimension, usagePerRequest)`                                                       |
| `net`   | Network edges: `edge(bytes, pattern, { from?, to? })`, billed as cross-AZ transfer                                            |

```ts
import { q, u } from 'pricesim'
import { edge, gauge, instancePool, request, service } from 'pricesim/model'
import { ec2, s3Bucket } from 'pricesim/aws'

const coreMs = u.vCPU.mul(u.ms)
const segments = s3Bucket('segments')
const nodes = instancePool('log-nodes', { instance: ec2['m7g.xlarge'], min: 3, loadFactor: 0.7, azs: 3 })

export const log = service('log', {
  deps: { segments },
  pools: { nodes },
  gauges: { retained: gauge(u.byte) },
  requests: ({ deps, pools }) => ({
    append: request({ bytes: u.byte }, (r) => ({
      use: [pools.nodes.cpu(q(0.1, coreMs))],
      // replicate to 2 more AZs: bills 2 crossings, and adds network demand on the nodes
      net: [edge(r.bytes, { kind: 'replicate', rf: 3 }, { from: pools.nodes, to: pools.nodes })],
      // one 8 MB segment upload per 8 MB appended
      calls: [deps.segments.put({ bytes: q(8, u.MB) }).times(r.bytes.div(q(8, u.MB)))],
    })),
  }),
  gaugeUse: (g, { pools }) => [pools.nodes.disk(g.retained)],
})
```

- Attributes are **unit-checked where one node calls another**, at compile time and again at runtime.
- `.times(n)` takes a number or a dimensionless `Expr`, so the call count can depend on the request's attributes (as above).

## Gauges

A gauge is a point-in-time level (bytes stored, open streams). It can:

- be **billed** as level × time: `gauge(u.byte, { billAs: storageDimension })`;
- drive **level demand** on pools through `gaugeUse`: `pools.x.memory(…)`, `pools.x.disk(…)`, `pools.x.hold('streams', …)`;
- **map** onto dependency gauges through `gaugeMap`: `deps.bucket.gauges.stored(g.retained)`.

Root gauge levels come from the workload (`pricesim guide workloads`).

## Network edges

`edge(bytes, pattern)` bills the cross-AZ fraction of `bytes` on the scenario's `interAz` dimension, and AWS charges both sides, so it's billed twice. Patterns: `{ kind: 'uniformClients', azs }` ((N−1)/N crosses), `{ kind: 'replicate', rf }` (rf−1 copies cross), `{ kind: 'crossAz', copies }` (an explicit expected number), `{ kind: 'sameAz' }` (none). With `from`/`to`, each end also gets the full bytes as network demand. A scenario whose requests declare edges must set `interAz`.

## Fixed charges and accounts

- `fixed: [fixedCharge(hourlyDimension, count)]` bills `count` units for the whole period, used or not (load-balancer hours, cluster fees).
- `account: 'customer'` on a node puts its charges (and its dependencies', unless they set their own) on another payer's bill, e.g. the customer's PrivateLink endpoint. Results then have `accounts`, and a price book's margin counts only the provider's cost.

## Custom capacity

A service can declare software capacity per instance of its pools, derived from the hardware: `capacity: { nodes: (hw) => ({ streams: q(50_000, stream) }) }`, then demand it with `pools.nodes.use('appends', …)` per request or `.hold('streams', …)` as a level. See `pricesim describe service`.

Details: `pricesim describe service`, `pricesim describe request`, `pricesim describe edge`, `pricesim describe gauge`, `pricesim describe fixedCharge`.
