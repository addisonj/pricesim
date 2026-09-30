---
title: Capacity
summary: Instance pools, node pools and pods, volumes, custom resources; how sizing works.
order: 7
---

Capacity is sized for **peak** demand over the period, held for the whole period, and never smaller than its minimum. Only demand you declare counts: a request that never calls `pool.cpu(…)` uses no CPU.

## Which pool

| You have                                                               | Use                                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Software that owns whole machines (brokers, databases, a storage tier) | `instancePool(name, { instance, min, loadFactor, azs, volumes? })`                                                                                            |
| Services packed onto a shared Kubernetes cluster                       | `nodePool(name, { instance, min, azs, reserved, maxPods, packingEfficiency })` plus `pods(name, { on, request, minReplicas, targetUtilization })` per service |
| A managed product with its own instances (Aurora)                      | the catalog offering; it brings its own pool                                                                                                                  |

## Demand

On any pool (instance pool or pod group), inside a service:

| Method                           | Kind                 | Unit                                                         |
| -------------------------------- | -------------------- | ------------------------------------------------------------ |
| `cpu(x)`                         | per request          | CPU time (millicore·s); write it as `q(n, u.vCPU.mul(u.ms))` |
| `network(x)`                     | per request          | bytes moved                                                  |
| `ebsBandwidth(x)`, `ebsIops(x)`  | per request          | bytes / operations against attached volumes                  |
| `memory(x)`, `disk(x)`           | level, in `gaugeUse` | bytes held                                                   |
| `use(name, x)` / `hold(name, x)` | per request / level  | a custom resource the service declares with `capacity`       |

## Sizing

- **Instance pool:** per resource, `ceil(peak demand / (per-instance capacity × loadFactor))`; the pool takes the largest (the **binding** resource) and at least `min`.
- **Pods:** replicas are `max(minReplicas, ceil(peak demand / (pod request × targetUtilization)))`; the node pool is then sized from the summed pod requests, after `reserved` per node and `packingEfficiency`, capped by `maxPods` per node.
- **Volumes** (`volumes: [{ type: gp3, size, iops?, throughput? }]`) are attached to every instance; they add disk, EBS bandwidth and IOPS, and are billed per instance. Volume size is fixed: when disk binds, the pool adds instances.
- `pricesim eval` prints each pool's count and binding resource; `binding: min` means the minimum, not load, set the size.

## Custom resources

For limits set by software rather than hardware (streams per node, partitions per broker, appends per second):

```ts
import { baseUnit, q, u } from 'pricesim'
import { gauge, instancePool, request, service } from 'pricesim/model'
import { ec2 } from 'pricesim/aws'

const stream = baseUnit('stream')
const nodes = instancePool('stream-nodes', { instance: ec2['m7g.xlarge'], min: 3, loadFactor: 0.8, azs: 3 })

export const streams = service('streams', {
  pools: { nodes },
  gauges: { open: gauge(stream) },
  // each node holds 20k open streams and 200k appends/s, whatever its size
  capacity: { nodes: () => ({ open: q(20_000, stream), appends: q(200_000, u.op.div(u.s)) }) },
  requests: ({ pools }) => ({
    append: request({}, () => ({ use: [pools.nodes.use('appends', q(1, u.op))] })),
  }),
  gaugeUse: (g, { pools }) => [pools.nodes.hold('open', g.open)],
})
```

The `capacity` function receives the pool's per-instance hardware (`hw.cpu`, `hw.memory`, …), so capacity can scale with the instance type.

## Reading idle cost

- Instance pools have one idle line, `headroom`: provisioned minus used instance-hours (minimum size, load factor, rounding, off-peak).
- Node pools split idle into `pod headroom: <group>`, `system overhead` (reserved) and `node slack` (allocatable that no pod requested).
- Pool cost is attributed by **dominant share**: each request or gauge path pays for the largest fraction of an instance it uses across resources.

Details: `pricesim describe instancePool`, `pricesim describe nodePool`, `pricesim describe pods`, `pricesim describe service`.
