# pricesim: high-level design

*Draft, 2026-09-24. Status: for review. No code yet.*

A TypeScript library for modeling the COGS of workloads on cloud infrastructure. It has four parts:

- **a pricing catalog**: cloud offerings with their real billing dimensions;
- **services**: offerings composed into services, and services composed into other services;
- **workloads**: time-varying inputs that drive those services;
- **evaluation**: turns all of the above into cost trees, unit costs, capacities, sweeps and closed-form expressions.

## 1. Goals and non-goals

**v1 goals**

- Model AWS core offerings with their real billing dimensions: EC2 (full instance catalog), EBS, S3 Standard, S3 Express One Zone, and data transfer. The catalog is generated from the AWS Price List API.
- Pricing features: on-demand prices, volume tiers, free tiers, commitments (RI/Savings Plans and flat negotiated discounts), and a simple regional multiplier.
- Services that consume cloud resources and other services, through *parameterized request types*. Costs are attributed as a tree.
- Provisioned pools with a minimum size (e.g. 3 nodes for HA), a load factor, and sizing for peak. The cost of unused capacity is reported as an explicit idle line.
- Time-varying workloads: rates and attributes as time series. Capacity is sized for the peak and usage charges are integrated over time.
- Explicit *gauges*: point-in-time quantities such as stored bytes and stream counts, derived from rates and retention.
- AZ-aware network edges: same-AZ vs cross-AZ fractions from placement and traffic patterns.
- Relations written as expressions with physical units. Closed-form expressions are simplified with a CAS. Anything else falls back to opaque code.
- A CLI that prints closed-form expressions and exports JSON/CSV.

**Designed for, not built in v1**

- Running in the browser: the core stays free of Node dependencies.
- GCP/Azure, other AWS services (DynamoDB etc.) and competitor price models (Confluent, MSK, S2, …). All of these fit the same `Offering` shape.
- Multi-tenant simulation: drawing tenant workloads from distributions and aggregating them. The evaluation API accepts many tenants and attributes costs per tenant, so a simulator can be layered on top.

**Non-goals**

- Autoscaling policies and spot pricing.
- Exact bin-packing. Pods from many services share node pools (§6.4), but node counts come from summed resource requests and a packing-efficiency factor, not a bin-packing solver.
- Burst credits.
- Exact per-region prices. v1 uses a regional multiplier.

## 2. Core concepts

```
Quantity   a number with units (12 GB, 0.023 USD/(GB*month))
Expr       symbolic expression over Quantities, Params, Symbols, and Opaque fns; unit-checked
Offering   a priced cloud product: billing dimensions + request types + gauges (leaf node)
Pool       provisioned capacity: instance type × count, with min, load factor, AZ spread
Service    a node that exposes request types and gauges, and consumes pools, offerings, other services
Workload   time series of request rates + attributes, plus gauges and parameters (retention etc.)
Scenario   services + workloads (+ tenants) + PricingContext
Evaluation CostTree, unit costs, capacity, sweeps, closed form
```

Every node in the graph (an `Offering` or a `Service`) has the same outward shape: it exposes **request types** (driven by rates) and **gauges** (point-in-time quantities such as bytes retained, stream counts or connections; like a metrics gauge, the value goes up and down). A service calls a dependency's request types and maps its own gauges onto the dependency's gauges, the same way whether that dependency is S3 or another service. This uniformity is what lets services nest to any depth and roll costs up as a tree.

## 3. Units and quantities

Units are checked twice: at compile time, by dimension types (§3.1, adopted after a spike), and at runtime, by dimension vectors. The runtime check is the source of truth and covers untyped inputs (CLI, JSON, generated data).

- **Base dimensions:** built-in `USD`, `s` (time), `byte`, `req` (requests), `op` (billable operations), `millicore`, `count`; models add their own with `baseUnit('stream')` (typed by name, registered by name at runtime so unit strings can use it).
- **Derived units:** `GB`, `GiB`, `TB`, `hour`, `month` (730 h), `Gbps`, `vCPU` (1000 millicore), `MB/s`, `USD/(GB*month)`, `millicore*s/req`, and so on.
- **Conversion** is automatic between compatible units, e.g. GB vs GiB, or hour vs month.
- **Errors:** a mismatch fails at the point where the expression is built, not when it's evaluated, e.g. adding `GB` to `GB/s`, or pricing `GB*month` with a `USD/GB` rate.

```ts
import { q, u } from 'pricesim'

const price = q(0.16, 'USD/(GB*month)')
const stored = q(4, 'TiB')
price.mul(stored)                // → Quantity USD/month (converted TiB→GB)
q(2, 'GB').add(q(1, 'GB/s'))     // throws UnitError: GB + GB/s
```

The string form shown here is for untyped boundaries (CLI, JSON, generated data). Model code uses typed unit constants (§3.1), e.g. `q(0.16, u.USD.div(u.GB.mul(u.month)))`.

### 3.1 Compile-time layer (adopted)

The idea is to carry a unit's *dimension* in the TypeScript type, so that `mul` and `div` compute the result's dimension and `add`, `sub`, `min` and `max` require equal dimensions. The runtime dimension vector stays the source of truth. The types are a second check that catches mistakes in the editor while a model is being written.

**Dimension as a type.** A dimension is a record of exponents, one per base dimension, where an absent key means 0. Exponent arithmetic is done with lookup tables over a small range (−4…+4), which keeps the type checker's work bounded.

```ts
// src/core/dim.ts (types only)
type Base = 'USD' | 's' | 'byte' | 'req' | 'op' | 'millicore' | 'count'   // built-ins; Dim keys may be any name
type Exp  = -4 | -3 | -2 | -1 | 0 | 1 | 2 | 3 | 4
type Dim  = { [K in Base]?: Exp }

type AddExp<A extends Exp, B extends Exp> = AddTable[A][B]        // generated 9×9 table; out of range → never
type NegExp<A extends Exp> = NegTable[A]

type Mul<A extends Dim, B extends Dim> = Simplify<Normalize<{ [K in Base]: AddExp<Get<A, K>, Get<B, K>> }>>
type Div<A extends Dim, B extends Dim> = Mul<A, { [K in Base]: NegExp<Get<B, K>> }>
// Normalize drops zero exponents so {USD:1, s:0} and {USD:1} are the same type
// Simplify forces TS to display the evaluated object, e.g. { s: -1; byte: 1 }
// Expr<D>/Unit<D> carry a phantom (d: D) => D field so D is invariant (no extra-property assignability)
// Same<A, B> is an exact-equality check that yields a readable 'unit mismatch' error property
```

**Units are typed constants, not strings.** Parsing unit strings with template-literal types is possible but slow and fragile, so the typed API builds units from constants. The string form stays available for the CLI and generated data, where it is checked at runtime only.

```ts
import { q, u } from 'pricesim'

// u.GB: Unit<{byte:1}>   u.month: Unit<{s:1}>   u.USD: Unit<{USD:1}>
const perGbMonth = u.USD.div(u.GB.mul(u.month))       // Unit<{USD:1, byte:-1, s:-1}>

const price  = q(0.16, perGbMonth)                     // Quantity<{USD:1, byte:-1, s:-1}>
const stored = q(4, u.TiB).mul(q(7, u.day))            // Quantity<{byte:1, s:1}>
const cost   = price.mul(stored)                       // Quantity<{USD:1}>  ✓

q(2, u.GB).add(q(1, u.GB.div(u.s)))
//          ~~~ TS error: Quantity<{byte:1, s:-1}> is not assignable to Quantity<{byte:1}>
```

**Expressions carry the dimension too.**

```ts
declare function sym<D extends Dim>(name: string, unit: Unit<D>): Expr<D>

const rate      = sym('produceRate', u.req.div(u.s))                  // Expr<{req:1, s:-1}>
const cpuPerReq = q(20, u.millicore.mul(u.ms).div(u.req))             // Quantity<{millicore:1, s:1, req:-1}>
const cpuDemand = rate.mul(cpuPerReq)                                  // Expr<{millicore:1}>  ✓ a capacity demand, not a rate
const perNode   = q(4000, u.millicore.div(u.count))

const nodes = max(q(3, u.count), ceil(cpuDemand.div(perNode)))        // Expr<{count:1}>
// max(q(3, u.count), cpuDemand)   → TS error: Expr<{millicore:1}> vs Quantity<{count:1}>
```

**The catalog and service definitions get typed signatures.** Generated files emit typed constants. Request definitions declare their attribute units, so a request body knows `r.bytes` is `Expr<{byte:1}>`:

```ts
// generated: src/catalog/aws/s3-express.gen.ts
export const storageRate = q(0.16, u.USD.div(u.GB.mul(u.month)))      // Quantity<{USD:1, byte:-1, s:-1}>

// request attrs are typed by their declared units
request({ bytes: u.byte, batch: u.count }, (r) => ({
  //       r.bytes: Expr<{byte:1}>,  r.batch: Expr<{count:1}>
  calls: [ deps.s3x.put({ bytes: r.bytes.mul(r.batch) }) ],           // ✓ put expects Expr<{byte:1}>
  // deps.s3x.put({ bytes: r.batch })                                  → TS error
}))

// a dependency's request type is typed from its definition
deps.store.append                  // (attrs: { bytes: Expr<{byte:1}> }) => Call
```

**Untyped values enter through a checked boundary.** Values from the CLI, sweeps, JSON and `opaque()` functions arrive as `Expr<AnyDim>`. `as()` checks the dimension at runtime and narrows the type:

```ts
const fromCli = parseQuantity(argv.rate)                 // Expr<AnyDim>, e.g. "5000 req/s"
const rate2   = fromCli.as(u.req.div(u.s))               // runtime check → Expr<{req:1, s:-1}>

const p99 = opaque('queueP99', { inputs: { rate, nodes }, unit: u.ms }, fn)   // Expr<{s:1}> by declaration
```

**Spike results** (`spike/units-types/`, see its README):

- **Cost:** typing adds about 0.03 s of check time to a realistic model (3 nested services, 20 request types, a 1,000-instance catalog), for 0.27 s total. At 10× scale it adds about 0.08 s, for 0.41 s total.
- **Coverage:** all 10 intentional unit mistakes are caught, with errors that name the expected and actual dimensions.
- **Rules that came out of the spike:**
  - Wrap derived dimensions in `Simplify<>`.
  - Make the dimension parameter invariant.
  - Use `Same<>`-style parameters on public APIs.
  - Never constrain graph nodes with `any`-typed `Expr`s.
  - Write service requests as a function of the context (§6).
  - Add number overloads, `mul(3)`, for dimensionless factors.
- **Enforcement:** the CLI runs `tsc --noEmit` before loading a model, because `tsx` and Bun don't type-check. `safe-units` isn't needed.

## 4. Expressions

The authoring style is a builder API, with an `opaque` escape hatch for anything that isn't closed-form.

```ts
import { sym, param, q, opaque, ceil, max, min } from 'pricesim/expr'

const rate      = sym('produceRate', u.req.div(u.s))          // free variable (workload input)
const bytes     = sym('msgBytes', u.byte)
const load      = param('loadFactor', q(0.6, u.one))   // named constant w/ default, overridable
const cpuPerReq = q(20, u.millicore.mul(u.ms).div(u.req)).add(bytes.mul(q(0.004, u.millicore.mul(u.ms).div(u.byte.mul(u.req)))))

const cpuDemand = rate.mul(cpuPerReq)                  // millicore (a rate × a per-req cost)
const nodes     = max(q(3,u.count), ceil(cpuDemand.div(q(4000,u.millicore.div(u.count)).mul(load))))

// Escape hatch: not closed-form (lookup table, iteration, simulation)
const p99 = opaque('queueP99', { inputs: { rate, nodes }, unit: 'ms' },
                   ({ rate, nodes }) => mm1QueueP99(rate, nodes))
```

- **Node kinds:** `Const(Quantity)`, `Sym` (free variable), `Param` (named, with a default, overridable per scenario), `Add/Sub/Mul/Div/Pow`, `Min/Max`, `Ceil/Floor`, `Piecewise` (for tiers), and `Opaque(fn, inputs, unit)`.
- **Units** are inferred and checked as each node is built.
- **Evaluation:** `expr.eval(bindings)` returns a Quantity. Each Sym gets a value from the workload or a sweep variable; each Param uses the scenario's value or its default.
- **Two modes:**
  - **exact** applies `ceil`, `max(min, …)` and tier piecewise functions literally.
  - **relaxed** drops `ceil`, turns `max(min, x)` into `x`, and uses a single tier's rate chosen at the operating point. It's a continuous relaxation meant for insight and closed form.

  Reports can show both modes side by side, so the idle and minimum-size tax stays visible.
- **Closed form:** `expr.closedForm({ mode: 'relaxed' })` strips units (they have already been checked), converts the AST to a mathjs node, runs `simplify`, and prints it with the units reattached to the result. If the tree contains an `Opaque` node, the output shows it as a named function, e.g. `queueP99(produceRate, nodes)`, and marks the result as not fully closed-form.
- **Solving:** for capacity questions, `solve(expr == target, sym)` tries a symbolic solve for linear or rational cases. If that fails it bisects numerically, which works as long as the expression is monotonic in `sym`.

*CAS choice:* mathjs, because it has `simplify`, `rationalize` and `derivative` and supports custom functions. We keep our own AST as the source of truth and convert to mathjs only to simplify and print. That keeps us free to swap CAS later (nerdamer or SymPy) if we hit its limits.

## 5. Pricing catalog

### 5.1 Billing dimensions and price schedules

```ts
interface BillingDimension {
  id: string                         // 'aws.s3express.storage'
  usageUnit: Unit                    // 'GB*month', 'req', 'GB', 'hour'
  schedule: PriceSchedule            // how usage → USD
  family: string                     // groups dims for commitments/discounts ('aws.ec2.compute')
  source: { url: string; retrieved: string; sku?: string }
}

type PriceSchedule =
  | { kind: 'flat'; rate: Quantity }                                   // USD per usageUnit
  | { kind: 'tiered'; period: 'month'; tiers: { upTo: Quantity | null; rate: Quantity }[] }
  | { kind: 'freeTier'; free: Quantity; then: PriceSchedule }
```

- **Pricing happens last (§8.1).** Evaluating a model only records *usage* per billing dimension. Schedules, tiers, commitments and discounts are applied afterwards to the usage totals for each billing period.
- **Tiers are pooled across the scenario.** The billing period's total usage for each dimension is summed across all consumers, the tiers are applied to that total, and the resulting *blended* rate is allocated back to consumers in proportion to their usage. (A marginal-rate view can come later.)

### 5.2 Offerings

An offering is a leaf node. Its request types and gauges translate usage into billing dimensions.

```ts
// pricesim/aws/s3-express-one-zone  (hand-written semantics, rates from generated data)
export const s3ExpressOneZone = offering('aws.s3express', {
  dimensions: { storage, putReqs, getReqs, uploadBytes, retrievalBytes },
  placement: { kind: 'singleAz' },                 // used by the network model
  gauges: {
    stored: gauge(u.byte, (g) => bill(storage, g.integral()))      // byte-seconds → GB-month
  },
  requests: {
    put: request({ bytes: u.byte }, (r) => [
      bill(putReqs, q(1, u.req)),
      bill(uploadBytes, max(q(0,u.byte), r.bytes.sub(q(512,u.KiB)))),   // per-GB above 512 KiB
    ]),
    get: request({ bytes: u.byte }, (r) => [ /* … */ ]),
  },
})
```

### 5.3 EC2 and capacity resources

Instances are *capacity resources*. They carry a capacity vector over splittable units, plus an hourly price.

```ts
interface InstanceType {
  id: 'm7g.2xlarge' | …                         // generated union of all instance types
  family: string; arch: 'arm64' | 'x86_64'; generation: number
  capacity: {
    cpu: Quantity          // millicore      (vCPU × 1000)
    memory: Quantity       // MB
    network: Quantity      // Gbps baseline (not "up to")
    ebsBandwidth: Quantity // MB/s baseline
    ebsIops: Quantity      // op/s baseline
    nvme?: { bytes: Quantity; readBw?: Quantity; writeBw?: Quantity }
  }
  price: BillingDimension                        // aws.ec2.<type>.hours, family 'aws.ec2.compute'
}

import { ec2 } from 'pricesim/aws/ec2'       // generated: ec2['m7g.2xlarge'], ec2.find({ … })
```

Pools size on these capacity resources: `cpu`, `memory`, `network`, `ebsBandwidth`, `ebsIops` and `disk` (memory and disk are levels held via `gaugeUse`; the rest are per-request demands). A pool sizes on every resource its instance type declares; demand on a resource the instance doesn't declare is an error. Local NVMe counts as `disk`.

A pool can attach one block-storage volume to each instance or node:

```ts
import { gp3 } from 'pricesim/aws'
pool({ instance: ec2['m7g.2xlarge'], min: 3, azs: 3, loadFactor: 0.6,
       volumes: [{ type: gp3, size: q(500, u.GiB), iops: q(6000, u.op.div(u.s)), throughput: q(250, u.MiB.div(u.s)) }] })
```

The volume is billed per instance (storage, and IOPS/throughput above the free baseline), split between used and idle like the instance-hours. Its size adds to `disk`, and its IOPS and throughput become `ebsIops`/`ebsBandwidth`, capped by the instance's EBS limits.
```

### 5.4 Generated data

- `scripts/fetch-aws-prices.ts` pulls from the AWS Price List API (bulk JSON, us-east-1) and writes `src/catalog/aws/*.gen.ts`.
- The generated files hold the full EC2 instance catalog (specs plus on-demand, RI and Savings Plan rates), EBS, S3, S3 Express One Zone and data transfer.
- Every generated file is checked in with its retrieval date and SKU ids, so price changes show up as reviewable diffs.
- The semantics (which dimensions a request touches, tier structure) are hand-written in non-generated modules that import the generated rates.

### 5.5 Pricing context

```ts
const ctx = pricing({
  region: 'us-east-1',
  regionMultiplier: { 'us-east-1': 1.0, 'ap-southeast-1': 1.3 },   // applied to all rates
  commitments: {
    'aws.ec2.compute': savingsPlan({ kind: 'compute', term: '1y', payment: 'noUpfront' }),
    // or: discount(0.30), or reserved({ term: '3y', payment: 'allUpfront' })
  },
  negotiatedDiscount: 0.10,          // EDP-style, applied after commitments
})
```

A commitment is resolved per dimension family. RI and Savings Plan rates come from the generated catalog when they exist, and from a flat `discount()` otherwise.

## 6. Services

```ts
import { service, instancePool, request, gauge, edge } from 'pricesim/model'
import { ec2 } from 'pricesim/aws/ec2'
import { s3ExpressOneZone } from 'pricesim/aws/s3-express-one-zone'
import { q, u, param } from 'pricesim'

const cpuMs = u.millicore.mul(u.ms)          // per-request CPU cost unit (millicore·seconds)
const segmentBytes = param('segmentBytes', q(8, u.MiB))   // overridable per scenario

export const logStore = service('logStore', {


  pools: {
    nodes: instancePool('logStore.nodes', { instance: ec2['m7g.2xlarge'], min: 3, azs: 3, loadFactor: 0.6 }),
  },
  deps: { s3x: s3ExpressOneZone },
  topology: { azs: 3 },

  gauges: {
    streams: gauge(stream),                                            // input or derived
    retained: gauge(u.byte, (w, p) => w.rate('append.bytes').mul(w.param('retention'))),
  },

  // requests are a function of the context, so deps/pools are fully typed (spike finding)
  requests: ({ deps, pools }) => ({
    append: request({ bytes: u.byte }, (r) => ({
      // rate demands on the pool (per request); summed × peak rate → required capacity
      use: [ pools.nodes.cpu(q(15,cpuMs).add(r.bytes.mul(q(0.002,cpuMs.div(u.byte))))),
             pools.nodes.network(r.bytes.mul(3)) ],                      // replication traffic
      // calls into dependencies, with multiplicity (can be fractional)
      calls: [ deps.s3x.put({ bytes: segmentBytes }).times(r.bytes.div(segmentBytes)) ],
      // network edges → data transfer charges (AZ-aware)
      net:   [ edge({ bytes: r.bytes, from: 'client', to: 'self', pattern: 'uniformClients' }),
               edge({ bytes: r.bytes.mul(2), pattern: 'replicate', rf: 3 }) ],
    })),
  }),

  // gauge demands (not per-request): memory/disk driven by gauges
  gaugeUse: (g, { pools }) => [ pools.nodes.memory(g.streams.mul(q(64, u.KB.div(stream)))) ],

  // map this service's gauges to dependency gauges
  gaugeMap: (g, { deps }) => [ deps.s3x.gauges.stored(g.retained) ],
})
```

### 6.1 Composition

A service that depends on another service calls its request types in exactly the same way:

```ts
export const streamApi = service('streamApi', {
  pools: { fe: instancePool('streamApi.fe', { instance: ec2['c7g.xlarge'], min: 2, azs: 3, loadFactor: 0.6 }) },
  deps:  { store: logStore, ddb: dynamodb /* later */ },
  requests: ({ deps, pools }) => ({
    produce: request({ bytes: u.byte, batch: u.count }, (r) => ({
      use:   [ pools.fe.cpu(q(40, cpuMs)) ],
      calls: [ deps.store.append({ bytes: r.bytes.mul(r.batch) }) ],
    })),
  }),
})
```

A dependency instance is shared by default. If two services depend on the same `logStore`, it is one pool, and its cost is split between them by *dominant share* of what each one drives (millicore-seconds, byte-seconds, and so on; §6.2). Idle cost is kept on a separate line. The API reserves a per-edge option (`dedicated()`) for per-caller instances.

### 6.2 Pool sizing

For each pool, at each time step:

1. **Rate demand** for each resource dimension is `Σ(rate × per-request use)` over all request types that route to the pool, including calls from upstream services.
2. **Gauge demand** for each resource dimension comes from `gaugeUse(gauges)`.
3. **Required nodes** for a dimension is `demand_d / (capacity_d × loadFactor)`. The pool's **size** is `max(min, ceil(max over dimensions of required nodes))`. The dimension with the largest requirement is the *binding dimension*, and the report includes it.
4. **Size for peak.** The provisioned count is the maximum size over the time series, and it is held for the whole period.
5. **Attribution by dominant share.** Each contributor (a request path or a gauge path) is charged its *dominant share* of the pool: the largest, over resources, of its resource-seconds divided by the pool's capacity-seconds of that resource. In instance-seconds that is `max_r(resourceSeconds_r / perInstanceCapacity_r)`, so a request that uses a little CPU on a memory-bound pool still pays for its CPU, and a request that uses both CPU and network pays for whichever is the larger fraction, not the sum. If the shares add up to more than the pool (contributors dominant on different resources), they are scaled down proportionally so that used never exceeds provisioned.
6. **Idle.** Whatever the shares don't cover is idle: min-size tax plus headroom plus off-peak. The cost tree prices it as `idle`. Attribution only moves cost between requests and idle; the pool's total is `count × period` either way.
7. **Unused capacity is still provisioned.** Every pool reachable from the root is provisioned at least at its minimum, even if no request in the workload touches it. For example, a 2-instance Aurora cluster behind an endpoint that isn't exercised is still charged, all of it as idle.
8. **Fixed charges.** A node can declare time-based base charges with `fixed: [fixedCharge(dimension, count)]`, for things like load balancer hours or serverless cluster-hour fees. They accrue for the whole period and are reported under `fixed`, separately from `used` and `idle`.

### 6.3 Network and AZs

- **Placement.** A service's `topology.azs` gives its AZ spread. Placement for offerings comes from the catalog, e.g. S3 Express One Zone is `singleAz`.
- **Traffic patterns.** Each edge pattern defines the fraction of its bytes that crosses AZs:

  | Pattern | Cross-AZ fraction |
  |---|---|
  | `uniformClients` over N AZs | (N−1)/N |
  | `replicate(rf)` | (rf−1) copies, each cross-AZ |
  | `sameAz` | 0 |
  | `toSingleAz(target)` | (N−1)/N from a spread service |

- **Billing.** Edges bill the data-transfer offering: cross-AZ is charged per GB in each direction, and internet egress is tiered.
- **Demand.** `edge(bytes, pattern, { from, to })` also adds `bytes` per request of network demand to the pools at both ends, whatever the pattern. Without `from`/`to` an edge only bills.
- **Per-offering access charges.** Whether cross-AZ access to an offering is billed as transfer is declared by the offering, not assumed.

### 6.4 Kubernetes: pods on shared node pools

In practice most services will run as pods on shared Kubernetes node pools, not on dedicated instances. The model therefore has two levels of capacity provider:

- **Node pool:** cluster infrastructure. It has an instance type, a minimum size, an AZ spread, per-node overhead reserved for the system (kubelet and daemonsets), a max-pods limit, and a packing-efficiency factor. Node pools are declared once and shared by many services.
- **Pod group:** owned by a service. It has per-pod resource *requests* (cpu and memory, and optionally network bandwidth), a minimum replica count, a target utilization and an AZ spread, and it runs on a node pool.

```ts
import { nodePool, pods } from 'pricesim/model'

export const general = nodePool('general', {
  instance: ec2['m7g.4xlarge'], min: 3, azs: 3,
  reserved: { cpu: q(400, u.millicore), memory: q(1.5, u.GB) },   // system/daemonset overhead per node
  maxPods: 110, packingEfficiency: 0.85,
})

export const streamApi = service('streamApi', {
  pools: { api: pods({ on: general, request: { cpu: q(500,u.millicore), memory: q(1,u.GB) },
                       minReplicas: 3, targetUtilization: 0.6, azs: 3 }) },
  requests: ({ pools }) => ({
    produce: request({ bytes: u.byte }, (r) => ({
      use: [ pools.api.cpu(q(40, cpuMs)) ],                      // same `use` API as an EC2 pool
    })),
  }),
})
```

Sizing happens in two steps:

1. **Replicas per pod group:** `max(minReplicas, ceil(max over dimensions of demand_d / (podRequest_d × targetUtilization)))`.
2. **Nodes per node pool:** `max(min, ceil(max over dimensions of Σ(replicas × podRequest_d) / ((nodeCapacity_d − reserved_d) × packingEfficiency)), ceil(Σ replicas / maxPods))`.

Cost attribution uses *usage*, by dominant share (§6.2). Each pod group is first allotted its requests' dominant share of the node pool (`replicas × max_r(podRequest_r / nodeCapacity_r)`), and the system reservation its own (`nodes × max_r(reserved_r / nodeCapacity_r)`); if those add up to more than the pool they are scaled down together. Within a group's allotment, each request or gauge path is charged its dominant share of node capacity for what it actually used (e.g. millicore-seconds and byte-seconds of memory), scaled down if they exceed the allotment. Everything left over is idle. Pods are modeled with limits equal to requests (Guaranteed QoS), so there is no overcommit. The tree shows three kinds of idle cost separately:

- **Pod headroom:** resources requested but not used.
- **Node slack:** allocatable capacity that no pod requested, including min-size and packing slack.
- **System overhead:** capacity reserved for the system.

A plain EC2 `pool()` is the degenerate case: one pod per node, with no reservation and no packing loss.

Services that own no capacity at all, such as pure orchestration layers, are allowed. Their requests just call their dependencies and add nothing at their own level.

## 7. Workloads

```ts
import { workload, series } from 'pricesim/workload'

const w = workload({
  period: q(30, u.day), step: q(1, u.hour),
  requests: {
    'streamApi.produce': {
      rate: series.diurnal({ mean: q(5000, u.req.div(u.s)), peakToMean: 2.5 }),  // or .constant / .fromArray / .symbolic
      attrs: { bytes: q(1, u.KB), batch: q(10, u.count) },              // scalars or series
    },
  },
  gauges: { 'logStore.streams': q(20000, stream) },
  params: { retention: q(7, u.day) },
})
```

- **Rates and attributes** can be constants, series, or *symbolic*. For closed form, a symbolic series is described by two symbols, `mean` and `peak`. Pools size from `peak`, and usage charges integrate `mean`.
- **Gauges** are either given directly or derived from rates (rate × retention, or the running integral of a rate).
- **Attribute distributions.** Request attributes can be drawn from a distribution, e.g. a mix of message sizes: `attrs: { bytes: dist.lognormal({ median: q(1,u.KB), p99: q(64,u.KB) }) }`.
  - **Distributions:** `dist.fixed`, `dist.empirical([{value, weight}])`, `dist.lognormal`, `dist.zipf`.
  - **Linear expressions** use the expectation analytically, so the result is exact and needs no sampling.
  - **Non-linear expressions** such as `ceil(bytes / segment)` or `max(0, bytes − 512 KiB)` use Monte Carlo sampling with a fixed number of draws.
  - **Determinism:** all sampling uses a seeded PRNG (`scenario({ seed })`), so every result is reproducible. The future multi-tenant simulator uses the same RNG machinery.
  - **Closed form:** `E[attr]` appears as a symbol, and the output is marked approximate wherever a non-linear expression touched a distribution.
- **Tenants.** `scenario({ tenants: [{ id, workload }] })` attributes cost per tenant. A future simulator produces the tenant list by sampling from distributions, e.g. Zipf-sized tenants with a mix of dimensions. The engine then evaluates the aggregate and attributes it back. Nothing in the core assumes a single workload.

## 8. Evaluation API

```ts
import { scenario, evaluate, unitCost, capacity, sweep, closedForm } from 'pricesim'

const sc = scenario({ root: streamApi, workload: w, pricing: ctx })

const r = evaluate(sc, { mode: 'exact' })       // → Result
r.total                                          // Quantity USD/month
r.tree                                           // CostTree (below)
r.pools.logStore.nodes                           // { count, bindingDim, utilization: {cpu, network, …} }

unitCost(sc, { per: 'streamApi.produce' })       // USD/req, fixed costs amortized, idle shown separately
unitCost(sc, { per: q(1, u.GB), of: 'streamApi.produce.bytes' })

capacity(sc, { fix: { 'logStore.nodes': 6 }, scale: 'streamApi.produce.rate' })
// → max sustainable rate + binding dimension (symbolic solve if linear, else bisection)

sweep(sc, { 'streamApi.produce.rate': range(100, 1e6, { log: true }),
            'logStore.nodes.instance': ['m7g.xlarge', 'm7g.2xlarge', 'i4g.xlarge'] })
// → rows of { inputs, total, perDim, bindingDim } for CSV/JSON

closedForm(sc, 'total', { mode: 'relaxed', keep: ['produceRate', 'msgBytes', 'streams'] })
// → "0.0412*produceRate*msgBytes + 0.93*streams + 1103.2  [USD/month]"  (illustrative)
```

### 8.1 Evaluation pipeline: usage first, price last

Evaluation runs in two phases. The model never computes prices while it walks the request graph.

1. **Usage phase.** For each time step, the engine walks the request graph for every tenant and workload. It sizes node pools, pod groups and pools for the peak, and writes a **usage ledger**. Each ledger entry records:
   - the consumer path (tenant → service → request → dependency …);
   - the billing dimension;
   - the time window;
   - the usage, as a Quantity (instance-hours, GB-months, requests, GB transferred, and so on).

   Idle capacity is also recorded, as usage entries tagged `idle`.
2. **Pricing phase.** Ledger entries are grouped by billing dimension and billing period, which is usually a month. Some dimensions may need other windows. For each group the engine:
   - applies the schedule (flat rate, tiers, free tier) to the pooled total;
   - applies the regional multiplier;
   - applies commitments per dimension family. Savings Plans, for example, apply to total compute spend, not to one instance.
   - applies the negotiated discount.

   The resulting effective rate is allocated back to the ledger entries in proportion to their usage, which produces the CostTree.

Consequences of this split:

- **Closed form stays tractable.** `closedForm` works on the symbolic usage expressions, and prices them with flat or effective rates. For a tiered dimension it uses the effective rate at the evaluated operating point, and reports that it did so. Tiers never enter the symbolic algebra.
- **The ledger is useful on its own** (`r.usage`), and the same usage can be re-priced under different pricing contexts (list, 1-year Savings Plan, EDP) without re-evaluating the model.

**CostTree node:**

```ts
interface CostNode {
  id: string                    // 'streamApi/produce/logStore/append/s3x/put/aws.s3express.putReqs'
  kind: 'service' | 'request' | 'pool' | 'offering' | 'dimension' | 'idle'
  cost: Quantity                // USD/month (report unit), exact mode
  relaxedCost?: Quantity
  usage?: Quantity              // in the dimension's usage unit
  tenant?: string
  children: CostNode[]
}
```

- **Export:** JSON (tree and results) and CSV (sweeps, plus a flattened tree with one row per leaf path).
- **Closed form:** an `Expr` or its printed string.

### 8.2 Price books: revenue and margin

A **price book** says what the provider charges its customers. It sits beside the workload, not inside the service graph, so the same model can be priced under different books: the provider's list prices, a proposal, or a competitor's list prices applied to the provider's own costs.

**Pieces:**

- **Meters** turn the root's traffic into billable quantities, in their own units:
  - a request meter covers one or more root request types, with a quantity per request computed from the request's attributes, e.g. `ceil(bytes / 1 KiB)` write units or `bytes` in GiB;
  - a gauge meter is a root gauge level × time, e.g. stream-months or GiB-months.

  Meters are computed from the workload (rates over the steps, attributes including distributions, gauge levels per step), so revenue and cost always describe the same traffic.
- **Options** are choices a customer makes, e.g. `network: 'public' | 'privatelink'` or `commit: 'none' | '1y'`. Each customer has a **plan** that picks one value per option; unset options take their default.
- **Price elements**, each optionally conditioned on the plan with `when: { network: 'privatelink' }`:
  - `charge(meter, schedule)`: a meter priced with a flat, tiered or free-tier schedule, the same schedules as billing dimensions. One meter can feed several charges, e.g. a base $/GiB for everyone plus a transit $/GiB for PrivateLink customers.
  - `fee(amount)`: a fixed amount per customer per month, e.g. a PrivateLink attachment fee.
  - `minimum(amount, { charges? })`: the customer pays at least `amount` for the named charges, or all of their charges. It shows as a top-up line.
  - `discount(fraction, { charges? })`: a percentage off the named charges, or off everything, e.g. for a commitment.

**Evaluation.** Tiers, minimums and discounts apply **per customer** per month: each tenant of a multi-tenant scenario is a customer, and a single-workload scenario is one customer. Order within a customer:
1. charges (tiers on that customer's monthly quantity);
2. discounts;
3. fees;
4. minimums.

**Margin** is revenue minus the **provider's** cost; costs billed to other accounts (e.g. the customer's own AWS charges) are excluded. It is reported:
- **in total and per customer.** A customer's cost is its attributed used cost plus a share of idle and fixed cost in proportion to its used cost, as `tenants` already does.
- **per meter.** A request meter's cost is the cost under its request types. A gauge meter's cost is the cost under its gauge; `costFrom` names the gauges it maps to further down the graph when the name changes. Costs no meter covers (idle, fixed, unmetered requests and gauges) show as an explicit **unallocated** line by default, or can be spread over meters in proportion to their cost (`allocate: 'proportional'`).

```ts
const book = priceBook(streamApi, {
  meters: {
    writeUnits: meter.requests({ append: (r) => ceil(r.bytes.div(q(1, u.KiB))) }, u.count),
    transferGiB: meter.requests({ append: (r) => r.bytes, read: (r) => r.bytes }, u.GiB),
    streamMonths: meter.gauge('streams', stream.mul(u.month)),
  },
  options: { network: { values: ['public', 'privatelink'], default: 'public' } },
  prices: [
    charge('writeUnits', tiered([{ upTo: 1e9, rate: 0.1 / 1e6 }, { upTo: null, rate: 0.06 / 1e6 }])),
    charge('transferGiB', 0.01),
    charge('transferGiB', 0.02, { when: { network: 'privatelink' }, name: 'privatelink transfer' }),
    fee(100, { when: { network: 'privatelink' }, name: 'privatelink attachment' }),
    charge('streamMonths', freeTier(10_000, 0.01)),
    minimum(500),
  ],
})
scenario({ name, root: streamApi, workload, pricing, priceBook: book, plan: { network: 'privatelink' } })
// multi-tenant: tenants carry their own plan: { id, workload, plan }
evaluate(sc).revenue  // { total, cost, margin, marginRate, lines, meters, customers }
```

## 9. CLI

```
pricesim eval   models/stream-api.ts --workload w/typical.ts --pricing ctx/list.ts --json out.json
pricesim sweep  models/stream-api.ts --var streamApi.produce.rate=1e2..1e6:log:20 --csv out.csv
pricesim closed models/stream-api.ts --quantity total --keep produceRate,msgBytes,streams
```

The CLI loads TypeScript model files directly using tsx or Bun. A TUI and a browser UI are later layers over the same core API.

**Self-documenting.** The CLI is also the documentation, for people and for coding agents:
- Every export registers its documentation inline, next to its definition (`doc({ … })`: summary, parameters, guidance, examples). `pricesim api` lists the exports and `pricesim describe <name>` prints one.
- Every command registers its usage, options, guidance and examples (`command({ … })`). `pricesim <cmd> --help` prints the usage and options, and `--describe` prints everything.
- `pricesim guide <topic>` prints task-oriented guides on how to write model code (`guides/*.md`).
- Tests check coverage and that the examples compile, so the docs can't drift from the code.
- Claude Code skills (`skills/`) hold only rules and a few examples, and send the agent to the CLI for details.

## 10. Package layout

```
pricesim/
  src/core/      units.ts  quantity.ts  expr.ts  cas.ts (mathjs bridge)  solve.ts
  src/pricing/   dimension.ts  schedule.ts  offering.ts  context.ts  tiers.ts
  src/model/     service.ts  pool.ts  k8s.ts  request.ts  gauge.ts  network.ts
  src/workload/  workload.ts  series.ts  dist.ts  random.ts (seeded PRNG)
  src/eval/      evaluate.ts  usage.ts (ledger)  price.ts  allocate.ts  size.ts  tree.ts  capacity.ts  sweep.ts  closed-form.ts
  src/catalog/aws/  ec2.gen.ts  ebs.gen.ts  s3.gen.ts  s3-express.gen.ts  transfer.gen.ts
                    ec2.ts  ebs.ts  s3.ts  s3-express-one-zone.ts  data-transfer.ts
  src/cli/
  scripts/fetch-aws-prices.ts
  examples/      three-node-kafka-like.ts  s3-direct-streams.ts
  test/          (vitest; golden tests against hand-computed bills and AWS Pricing Calculator estimates)
```

- **Runtime:** TypeScript (ESM), vitest for tests, mathjs as the only core dependency.
- **Browser-safe:** `src/core`, `pricing`, `model`, `workload` and `eval` contain no Node APIs.

## 11. Open questions

**Resolved**

- **Services with no capacity of their own:** allowed. Kubernetes pods on shared node pools are now the main compute model (§6.4).
- **Tiers:** evaluation only collects usage, and pricing happens last (§8.1). Tiers never enter the symbolic algebra.
- **Peak definition:** v1 uses the max over time steps. Sizing goes through a pluggable `peak(series)` reducer, so a percentile can be added later without architectural change.
- **Attribute distributions:** in v1, seeded and deterministic (§7).
- **Validation:** there are no real bills to calibrate against. Golden tests use hand-computed bills and AWS Pricing Calculator estimates instead.

- **Pool cost split:** each contributor is charged its dominant share of the pool over all resources, and the remainder is idle (§6.2, §6.4). Earlier versions charged usage of the binding dimension only, so a memory-heavy service on a CPU-bound pool paid only for its CPU.
- **Pod limits vs requests:** assume limits equal requests, with no overcommit.
- **Billing windows:** every v1 dimension is additive over time: EC2 per-second, EBS and S3 prorated GB-month, per-request and per-GB charges. Fine-grained metering such as per-second or per-minute billing needs no special handling, because the ledger already integrates usage per time step. The only thing that needs a billing window at pricing time is the monthly volume tiers. The ledger keeps per-step resolution, so pricing that is *not* additive over time (e.g. charges on an hourly peak, or minimum durations) can be added later without changing the ledger.

- **Compile-time units:** adopted after a spike (§3.1, `spike/units-types/`). It adds under 0.1 s of check time and catches 10 of 10 test mistakes with readable errors.

**Open**

None at this stage.
