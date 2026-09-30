# Model-authoring guide

This guide is for someone writing their first cost model with `pricesim`. It covers the concepts, builds a small model step by step, shows how to run each CLI command and read its output, and ends with the mistakes that are easy to make.

The model built here is [`examples/guide-example.ts`](../examples/guide-example.ts). It runs as is, and [`test/guide-example.test.ts`](../test/guide-example.test.ts) checks the numbers quoted below. For the API, run `pricesim api` and `pricesim describe <name>` (also rendered to [api.md](api.md)); for topic guides, `pricesim guide`. For the reasoning behind the design, see [DESIGN.md](../DESIGN.md).

## Contents

1. [Concepts](#1-concepts)
2. [Walkthrough: a file-upload service](#2-walkthrough-a-file-upload-service)
3. [Running the CLI](#3-running-the-cli)
4. [Reading the cost tree](#4-reading-the-cost-tree)
5. [Pitfalls](#5-pitfalls)

## 1. Concepts

A model is a graph of **nodes**. Each node is either an **offering** (a priced cloud product, a leaf) or a **service** (your code, which consumes offerings, capacity and other services). Every node exposes **request types** and **gauges** in the same way, which is what lets services nest to any depth. A **workload** drives the root node, and a **scenario** ties the root, the workload and a **pricing context** together. Evaluating a scenario first records _usage_ per billing dimension, then prices it, then folds the costs into a tree.

### Units and `Expr`

Every quantity is an `Expr<D>`: a symbolic expression whose dimension `D` is tracked twice, by the TypeScript type and by a runtime exponent vector. The built-in base dimensions are `USD`, `s`, `byte`, `req`, `op`, `millicore` and `count`.

**Custom dimensions.** Anything else your model counts (streams, partitions, tenants, messages) gets its own dimension with `baseUnit`:

```ts
import { baseUnit, defineUnit, q, u } from 'pricesim'

const stream = baseUnit('stream') // Unit<{ stream: 1 }>
const partition = baseUnit('partition') // Unit<{ partition: 1 }>
const perPartition = stream.div(partition) // Unit<{ stream: 1; partition: -1 }>

q(10_000, perPartition).mul(q(24, partition)) // Expr<{ stream: 1 }>
q(1, stream).add(q(1, partition)) // compile error: unit mismatch
```

The type system tracks custom dimensions by name like the built-ins. The runtime recognizes them by name too: `baseUnit('stream')` returns the same dimension from any module, and once it exists unit strings like `'stream/s'` parse at untyped boundaries (CLI, JSON). `defineUnit('kstream', stream, 1000)` registers a scaled name. Built-in names can't be reused.

```ts
import { ceil, max, param, q, sym, u } from 'pricesim'

const price = q(0.023, u.USD.div(u.GB.mul(u.month))) // Expr<{ USD: 1; byte: -1; s: -1 }>
const stored = q(4, u.TiB) // Expr<{ byte: 1 }>
price.mul(stored) // Expr<{ USD: 1; s: -1 }>: USD per second, converted from TiB and month

q(2, u.GB).add(q(1, u.GB.div(u.s))) // compile error, and at runtime: UnitError: unit mismatch in +: byte vs s^-1*byte
```

- **Units** (`u.*`) are typed constants: `u.KB`, `u.GiB`, `u.hour`, `u.month` (730 hours), `u.vCPU` (1000 millicore), `u.Gbps`, and so on. Build compound units with `.mul()` and `.div()`.
- **Values are stored in base units** (bytes, seconds, millicores). `e.eval()` returns base units; `e.in(u.GB)` converts.
- **Dimensionless factors** use number overloads: `.mul(3)`, `.div(2)`.
- **`sym(name, unit)`** is a free variable, bound at evaluation time. **`param(name, default)`** is a named constant that a workload (`params: { name: … }`) or a sweep can override.
- **`max`, `min`, `ceil`, `floor`** build expressions; `opaque(name, { inputs, unit }, fn)` wraps any numeric function that has no closed form.
- **Untyped boundaries** (CLI strings, JSON) go through `parseQuantity('5000 req/s')` or `parseUnit('USD/(GB*month)')` and are narrowed with `.as(unit)`, which checks the dimension at runtime.

### Billing dimensions and offerings

A **billing dimension** is one line of a cloud bill: an id, a usage unit, a price schedule (flat, tiered or free tier) and a family used for discounts.

```ts
import { dimension, freeTier, tiered } from 'pricesim'

dimension('example.queue.requests', u.req, freeTier(1e6, 0.4e-6)) // first 1M requests free, then $0.40/M
dimension(
  'example.storage',
  u.GB.mul(u.month),
  tiered([
    { upTo: 50_000, rate: 0.023 },
    { upTo: null, rate: 0.022 },
  ]),
)
```

Rates are USD per one usage unit. Tiers and free tiers apply to the **pooled monthly usage** of the dimension across every consumer on the same bill (per paying account), and the resulting blended rate is allocated back in proportion to usage.

An **offering** is a node whose request types `bill` dimensions. The AWS catalog (`pricesim/aws`) provides ready-made offerings: `s3Bucket`, `s3ExpressBucket`, `dynamoTable`, `auroraPostgres`, `applicationLoadBalancer`, `networkLoadBalancer`, `natGateway`, `internetEgress` and `directConnect`, plus every current-generation EC2 instance type as `ec2['m7g.xlarge']`.

### Services, requests and calls

A **service** declares its dependencies (`deps`), its capacity (`pools`), its gauges, and its request types. `requests` is a function of `{ deps, pools }`, so calls into dependencies are fully typed.

A **request type** has typed attributes and a body. The body returns up to four lists, all **per single request**:

| Field   | What it holds                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------ |
| `use`   | Demand on capacity: `pools.x.cpu(cpuTimePerRequest)`, `pools.x.network(bytesPerRequest)`         |
| `calls` | Calls into dependencies: `deps.y.put({ bytes })`, optionally `.times(0.3)` for "30% of requests" |
| `bill`  | Direct usage of a billing dimension: `bill(dimension, usagePerRequest)`                          |
| `net`   | Network edges, billed as cross-AZ transfer: `edge(bytes, pattern)`                               |

Attributes are checked where one node calls another: the caller's values must match the callee's declared units, at compile time and again at runtime.

### Capacity: instance pools, node pools and pods

Capacity is sized for the **peak** demand over the period, held for the whole period, and never smaller than its minimum.

- **Instance pool** (`instancePool`): whole instances of one type, e.g. an EC2 fleet or database instances. The count is `max(min, ceil(peak demand / (capacity × loadFactor)))`, taken over every resource the instance type has (CPU, memory, network, EBS bandwidth and IOPS, disk) and any custom resource a service declares; the resource that needs the most instances is the _binding_ one.
- **Node pool** (`nodePool`): a Kubernetes node group shared by many services. Each node has some capacity `reserved` for the system, pods fill only `packingEfficiency` of what is left, and `maxPods` caps pods per node.
- **Pod group** (`pods`): a Deployment owned by a service, running on a node pool. Replicas are `max(minReplicas, ceil(peak demand / (podRequest × targetUtilization)))`; the node pool is then sized from the summed pod requests.

Requests place demand on pools with `cpu()`, `network()`, `ebsBandwidth()` and `ebsIops()`, as an amount per request. Gauges place level demand with `memory()` and `disk()` in `gaugeUse`. `use()` and `hold()` do the same for custom resources (`pricesim guide capacity`).

### Gauges

A **gauge** is a point-in-time level: bytes stored, files kept, open streams. A gauge can:

- be **billed** as level × time, with `gauge(u.byte, { billAs: storageDimension })` (bytes × seconds → GB-month);
- drive **memory** demand, through `gaugeUse: (g, { pools }) => [pools.x.memory(...)]`;
- **map** onto dependency gauges, through `gaugeMap: (g, { deps }) => [deps.y.gauges.stored(...)]`.

Root gauge levels come from the workload, either as constants or **derived from request rates**: `gauges: ({ rate }) => ({ files: rate.upload.mul(q(30, u.day)).mul(q(1, u.count.div(u.req))) })`. `rate.upload` is the mean upload rate over the period, so derived gauges follow sweeps and stay symbolic in closed forms.

### Network edges

`edge(bytes, pattern)` in a request's `net` list bills the cross-AZ fraction of `bytes` on the scenario's `interAz` dimension, **twice** (AWS charges both the sending and the receiving side):

| Pattern                              | Cross-AZ fraction         |
| ------------------------------------ | ------------------------- |
| `{ kind: 'uniformClients', azs: N }` | (N−1)/N                   |
| `{ kind: 'replicate', rf: R }`       | R−1 copies, each crossing |
| `{ kind: 'crossAz', copies: C }`     | C copies, each crossing   |
| `{ kind: 'sameAz' }`                 | 0                         |

With `edge(bytes, pattern, { from, to })`, each end also gets the full bytes as network demand. A scenario whose requests declare edges must set `interAz` (e.g. `interAz` from `pricesim/aws`).

### Fixed charges

`fixed: [fixedCharge(hourlyDimension, count)]` on a node bills `count` units for the whole period, used or not: load balancer hours, NAT gateway hours, cluster fees. The dimension's usage unit must be a time.

### Workloads and scenarios

A **workload** is written against the root node, so request names, attributes and gauges are type-checked. It gives, per root request type, a rate **series** (`series.constant`, `series.diurnal`, `series.fromArray`) and the attributes. It can also set gauge levels, param overrides, the period (default 730 hours), the step (default 1 hour), and how peaks are measured (`peak: 'max'` or `{ percentile: 99 }`).

A **scenario** is `{ name, root, workload, pricing, interAz? }`. `pricing({ region, familyDiscounts, negotiatedDiscount, regionMultipliers })` sets the region multiplier and discounts.

### Tenants

Replace `workload` with `tenants: [{ id, workload }, …]` to model several customers on one deployment. Capacity is sized on their **combined** demand, the tree gets one branch per tenant, and `result.tenants` gives each tenant its used cost plus a share of idle and fixed cost in proportion to used cost. `evaluate()` and `pricesim eval` support tenants (the CLI summary lists the top tenants); `unitCosts`, `closedForm`, `sweep` and `capacity` do not yet.

## 2. Walkthrough: a file-upload service

We will model an `uploads` API:

```
uploads (pods on the `general` k8s node pool)
├── alb:uploads         Application Load Balancer: hourly fixed charge + LCUs
├── s3:files            S3 Standard bucket
├── queue:thumbnails    an offering we write ourselves
└── search              its own EC2 instance pool, sized by the memory its index holds
```

Clients upload and download files of about 500 KB. Every upload is stored in S3, enqueues a thumbnail job and is indexed for search. Files are kept for 30 days.

The imports:

```ts
import { dimension, freeTier, pricing, q, scenario, series, u, workload } from 'pricesim'
import { bill, edge, gauge, instancePool, nodePool, offering, pods, request, service } from 'pricesim/model'
import { applicationLoadBalancer, ec2, interAz, s3Bucket } from 'pricesim/aws'

/** CPU time per request, in milliseconds of one core (1 core·ms = 1000 millicore·ms) */
const coreMs = u.vCPU.mul(u.ms)
const perSecond = u.req.div(u.s)
```

### Step 1: an offering of our own

The catalog doesn't have a queue, so we write one. The price here is illustrative, not a real price list.

```ts
const queueRequests = dimension('example.queue.requests', u.req, freeTier(1e6, 0.4e-6), { family: 'example.queue' })

const thumbnailQueue = offering('queue:thumbnails', {
  requests: () => ({
    send: request({}, () => ({ bill: [bill(queueRequests, q(1, u.req))] })),
  }),
})
```

`bill(queueRequests, q(1, u.req))` says each `send` uses one request of the dimension. `bill` checks that the usage has the dimension's unit, so `bill(queueRequests, q(1, u.byte))` is a compile error.

### Step 2: capacity

A shared Kubernetes node pool of `m7g.xlarge` nodes (4 vCPU, 16 GiB), at least 3, with 400 millicores and 1.5 GiB per node reserved for the kubelet and daemonsets:

```ts
const general = nodePool('general', {
  instance: ec2['m7g.xlarge'],
  min: 3,
  azs: 3,
  reserved: { cpu: q(400, u.millicore), memory: q(1.5, u.GiB) },
  maxPods: 58,
  packingEfficiency: 0.85,
})
```

### Step 3: a service on its own instance pool

Search runs on at least two `r7g.large` instances (2 vCPU, 16 GiB) and keeps about 1 KB of index per document in memory. Memory is a level, so it is declared in `gaugeUse`, driven by the `docs` gauge:

```ts
const search = service('search', {
  pools: {
    nodes: instancePool('search-nodes', { instance: ec2['r7g.large'], min: 2, loadFactor: 0.7, azs: 2 }),
  },
  gauges: { docs: gauge(u.count) },
  requests: ({ pools }) => ({
    index: request({}, () => ({ use: [pools.nodes.cpu(q(0.5, coreMs))] })),
    lookup: request({}, () => ({ use: [pools.nodes.cpu(q(4, coreMs))] })),
  }),
  gaugeUse: (g, { pools }) => [pools.nodes.memory(g.docs.mul(q(1, u.KB.div(u.count))))],
})
```

`loadFactor: 0.7` means instances are sized to run at 70% of the binding resource at peak.

### Step 4: the root service

`uploads` runs as pods on `general` and calls everything else:

```ts
const lb = applicationLoadBalancer('uploads')
const files = s3Bucket('files')

export const uploads = service('uploads', {
  deps: { lb, files, queue: thumbnailQueue, search },
  pools: {
    api: pods('uploads-api', {
      on: general,
      request: { cpu: q(1000, u.millicore), memory: q(2, u.GiB) },
      minReplicas: 2,
      targetUtilization: 0.6,
    }),
  },
  gauges: { files: gauge(u.count) },
  requests: ({ deps, pools }) => ({
    upload: request({ bytes: u.byte }, (r) => ({
      // 3 core·ms fixed + 2 core·ms per MB received
      use: [pools.api.cpu(q(3, coreMs).add(r.bytes.mul(q(2, coreMs.div(u.MB)))))],
      calls: [
        deps.lb.forward({ bytes: r.bytes }),
        deps.files.put({ bytes: r.bytes }),
        deps.queue.send({}),
        deps.search.index({}),
      ],
      // clients in 3 AZs reach pods in 3 AZs: 2/3 of the bytes cross an AZ boundary
      net: [edge(r.bytes, { kind: 'uniformClients', azs: 3 })],
    })),
    download: request({ bytes: u.byte }, (r) => ({
      use: [pools.api.cpu(q(1, coreMs))],
      calls: [deps.lb.forward({ bytes: r.bytes }), deps.files.get({ bytes: r.bytes })],
      net: [edge(r.bytes, { kind: 'uniformClients', azs: 3 })],
    })),
    find: request({}, () => ({
      use: [pools.api.cpu(q(0.5, coreMs))],
      calls: [deps.search.lookup({})],
    })),
  }),
  // every stored file is ~500 KB in S3 and one document in the search index
  gaugeMap: (g, { deps }) => [
    deps.files.gauges.stored(g.files.mul(q(500, u.KB.div(u.count)))),
    deps.search.gauges.docs(g.files),
  ],
})
```

Things to notice:

- **Per-request CPU is an expression of the attributes.** `r.bytes` is an `Expr<{ byte: 1 }>`, so `r.bytes.mul(q(2, coreMs.div(u.MB)))` is CPU time, and `pools.api.cpu()` accepts it.
- **Calls pass attributes in the callee's units.** `deps.files.put` expects `{ bytes: Expr<{ byte: 1 }> }`; passing a count would not compile.
- **`gaugeMap` translates gauges.** The service knows how many files it keeps; S3 needs bytes and search needs documents.
- **The ALB is a dependency**, so its hourly charge becomes a fixed charge of this scenario, and each `forward` bills LCU-hours from processed bytes.

### Step 5: the workload

```ts
export const typical = workload(uploads, {
  requests: {
    upload: {
      rate: series.diurnal({ mean: q(20, perSecond), peakToMean: 2 }),
      attrs: { bytes: q(500, u.KB) },
    },
    download: {
      rate: series.diurnal({ mean: q(200, perSecond), peakToMean: 1.5 }),
      attrs: { bytes: q(500, u.KB) },
    },
    find: { rate: series.constant(q(50, perSecond)), attrs: {} },
  },
  // files kept for 30 days: a gauge derived from the mean upload rate
  gauges: ({ rate }) => ({ files: rate.upload.mul(q(30, u.day)).mul(q(1, u.count.div(u.req))) }),
})
```

`series.diurnal` is a daily sine wave: uploads average 20/s and peak at 40/s. Capacity is sized for the peak; usage (requests, bytes, transfer) is integrated over the hourly steps.

The derived gauge is a rate × a time: 20 req/s × 30 days ≈ 52 million files. The trailing `q(1, u.count.div(u.req))` turns requests into files, so the units work out to `count`.

### Step 6: the scenario

```ts
export default scenario({
  name: 'uploads',
  description: 'file uploads on a shared k8s node pool; S3, an ALB, a queue, and a search tier on EC2',
  root: uploads,
  workload: typical,
  pricing: pricing({ region: 'us-east-1' }),
  interAz,
})
```

The CLI loads the default export (or an export named `scenario`). From code:

```ts
import { evaluate } from 'pricesim'
import sc from './examples/guide-example.ts'

const r = evaluate(sc)
r.total // 7979.03 (USD/month)
r.pools.find((p) => p.name === 'search-nodes') // { count: 5, binding: 'memory', … }
```

### Tenants

The example file also exports `shared`, the same deployment used by two customers with constant upload rates of 1/s and 19/s:

```ts
export const shared = scenario({
  name: 'uploads-shared',
  root: uploads,
  tenants: [
    { id: 'small', workload: perTenant(1) },
    { id: 'large', workload: perTenant(19) },
  ],
  pricing: pricing(),
  interAz,
})
```

`evaluate(shared).tenants` gives:

| Tenant | used     | idle share | fixed share | total    |
| ------ | -------- | ---------- | ----------- | -------- |
| small  | $83.93   | $25.50     | $0.82       | $110.25  |
| large  | $1594.60 | $484.52    | $15.60      | $2094.72 |

### Step 7: a price book, and the margin

A **price book** says what you charge. It is defined against the root, like a workload, and attached to a scenario, so the same model can be priced under several books (DESIGN.md §8.2):

```ts
export const uploadPrices = priceBook(uploads, {
  name: 'uploads list prices',
  meters: (m) => ({
    uploadedGB: m.requests({ upload: (r) => r.bytes }, u.GB),
    downloadedGB: m.requests({ download: (r) => r.bytes }, u.GB),
    // files held: file-months; its cost is S3 storage and the search index further down the graph
    fileMonths: m.gauge('files', u.count.mul(u.month), { costFrom: ['stored', 'docs', 'memory'] }),
  }),
  options: { support: { values: ['standard', 'premium'], default: 'standard' } },
  prices: [
    charge(
      'uploadedGB',
      tiered([
        { upTo: 10_000, rate: 0.02 },
        { upTo: null, rate: 0.015 },
      ]),
    ),
    charge('downloadedGB', 0.01),
    charge('fileMonths', freeTier(100_000, 0.0001)),
    fee(500, { when: { support: 'premium' }, name: 'premium support' }),
    minimum(50),
  ],
})
```

- **Meters** turn the root's traffic into billable quantities. `m.requests` takes a quantity per request for one or more root request types, computed from the request's attributes (e.g. `ceil(r.bytes.div(q(1, u.KiB)))` for 1 KiB units). `m.gauge` is the gauge's level × time. Both are type-checked against the root.
- **Prices:**
  - `charge(meter, schedule)`, with the same flat, tiered and free-tier schedules as billing dimensions. One meter can feed several charges.
  - `fee(amount)` per customer per month.
  - `minimum(amount, { covers? })`, a top-up to at least `amount`.
  - `discount(fraction, { covers? })`.
- **Options** are customer choices. Any price can be conditioned on the plan with `when`, e.g. a base $/GB for everyone plus a PrivateLink surcharge on the same meter: `charge('transferGB', 0.03, { when: { network: 'privatelink' }, name: 'privatelink transfer' })`.

A scenario takes `priceBook` and a `plan`; in a multi-tenant scenario each tenant carries its own `plan`, and **tiers, minimums and discounts apply per customer**:

```ts
export const sharedPriced = scenario({
  name: 'uploads-shared-priced',
  root: uploads,
  tenants: [
    { id: 'small', workload: perTenant(1) },
    { id: 'large', workload: perTenant(19), plan: { support: 'premium' } },
  ],
  pricing: pricing(),
  interAz,
  priceBook: uploadPrices,
})
```

`evaluate(sharedPriced).revenue` has the bill lines, and margin in total, per meter and per customer. Margin is against the **provider's** cost only; costs billed to other accounts are excluded. A request meter's cost is the cost under its requests, and a gauge meter's cost is the cost under its gauge (`costFrom` names the gauges it becomes further down). What no meter covers (idle, fixed charges, unmetered requests) is an `unallocated` line; `allocate: 'proportional'` spreads it over the meters instead. `pricesim eval` prints the summary:

```
revenue (uploads list prices): $6,114.77/month   provider cost $2,204.97   margin $3,909.80 (63.9%)
  uploadedGB               revenue      $450.77  cost      $846.84  margin     $-396.07
  downloadedGB             revenue        $0.00  cost        $0.00  margin        $0.00
  fileMonths               revenue    $5,164.00  cost      $832.08  margin    $4,331.92
  unallocated cost                               cost      $526.06

customers (2):
  large                    revenue    $5,839.29  cost    $2,094.72  margin   64.1%
  small                    revenue      $275.48  cost      $110.25  margin   60.0%
```

Here uploads are sold below cost and file storage carries the margin.

## 3. Running the CLI

The CLI is `pricesim`; inside this repo run it as `pnpm cli <command>`. Every command takes a model file, type-checks it with the nearest `tsconfig.json` first (skip with `--no-typecheck`), and loads its default export. Summaries go to stderr; `--json [file]` (and `--csv [file]` for sweeps) write machine-readable output to the file, or to stdout without one. All costs are USD per month.

### `pricesim eval`: the cost tree

```sh
pnpm cli eval examples/guide-example.ts
```

```
$ tsx src/cli/main.ts eval examples/guide-example.ts --no-typecheck
uploads (us-east-1, 730 h in 730 steps)
total $7,979.03/month   used $7,465.12   idle $497.48   fixed $16.43

   $7,465.12   93.6%  uploads
     $5,794.09   72.6%  download
       $3,486.84   43.7%  cross-az
       $2,092.11   26.2%  alb:uploads
         $209.21    2.6%  s3:files
           $5.93    0.1%  uploads-api
       $838.54   10.5%  upload
         $346.97    4.3%  cross-az
         $260.23    3.3%  s3:files
         $208.18    2.6%  alb:uploads
          $20.42    0.3%  queue:thumbnails
           $2.36    0.0%  uploads-api
           $0.39    0.0%  search
       $823.93   10.3%  gauges
         $590.32    7.4%  s3:files
         $233.61    2.9%  search
         $8.56    0.1%  find
           $7.82    0.1%  search
           $0.74    0.0%  uploads-api
     $497.48    6.2%  idle
       $348.38    4.4%  general
         $262.10    3.3%  node slack
          $50.54    0.6%  pod headroom: uploads-api
          $35.74    0.4%  system overhead
       $149.10    1.9%  search-nodes
         $149.10    1.9%  headroom
      $16.43    0.2%  fixed
        $16.43    0.2%  alb:uploads
          $16.43    0.2%  aws.elb.alb.hours

capacity:
  search-nodes                    5 × r7g.large  (binding: memory, min 2)
  uploads-api                     2 × pods on general  (binding: min, min 2)
  general                         3 × m7g.xlarge  (binding: min, min 3)
```

The printed tree stops at three levels. `--json out.json` writes the full result: the whole tree down to billing dimensions, a `dimensions` list (usage, list cost, cost and effective rate per billing dimension), and `pools` (count, binding resource, and peak/mean/capacity per resource). Its shape is specified by [`schema/result.schema.json`](../schema/result.schema.json).

### `pricesim unit-cost`: cost per request type

```sh
pnpm cli unit-cost examples/guide-example.ts --rate 100
```

```
uploads: each request type alone at 100 req/s (us-east-1, USD/month)

request             total/mo        used       idle     fixed   $/M used  $/M all-in
upload             $4,752.12   $4,235.79    $499.91    $16.43     $16.12      $18.08
                used by: cross-az $1,752.00, s3:files $1,314.00, alb:uploads $1,051.20, queue:thumbnails $104.72
download           $3,438.52   $2,911.30    $510.80    $16.43     $11.08      $13.08
                used by: cross-az $1,752.00, alb:uploads $1,051.20, s3:files $105.12, uploads-api $2.98
find                 $530.20      $17.13    $496.65    $16.43      $0.07       $2.02
                used by: search $15.64, uploads-api $1.49
```

Each request type is evaluated **alone** at a constant rate (default 1000 req/s), with the scenario's attributes and without gauges (add `--with-gauges` to keep them). "$/M used" is the request-driven cost per million requests; "$/M all-in" also spreads the idle and fixed cost of the whole deployment over those requests, so it shows the minimum-size tax at that rate. Use `--request upload` (repeatable) to pick request types.

### `pricesim closed`: cost as a formula

```sh
pnpm cli closed examples/guide-example.ts --mode relaxed
```

```
uploads: total USD/month (relaxed)

  = 60.8302 * rate_upload + 28.032 * (rate_upload + rate_download) + 1.0512 * rate_download + 16.425 + 0.0648889 * (8.04456 * rate_upload + 1.50308 * rate_download + 0.5 * rate_find)

at the scenario's values: $7,595.80   (numeric evaluation: $7,979.03)

kept symbols (base units):
  rate_upload                  =      19.8042 req/s
  rate_download                =      199.021 req/s
  rate_find                    =           50 req/s

linear form:
  constant $16.43
  rate_upload                  $89.38 per unit
  rate_download                $29.18 per unit
  rate_find                    $0.03 per unit

assumptions:
  - each billing dimension is priced at its effective rate at the operating point (tiers, discounts, region multiplier)
  - capacity is sized from request peaks, assumed to coincide
  - relaxed: pools have no ceil() or minimum sizes and are sized on their binding dimension at the operating point (ceil() inside billing expressions, e.g. request units, is kept)
```

The total is an expression over the **kept** symbols; everything else is bound to its scenario value. By default the mean rates are kept. Read the linear form as "each extra upload per second (sustained) costs $89.38/month", which includes the 30 days of storage and search memory it leaves behind, because the `files` gauge is derived from the upload rate.

- **`--mode exact`** (the default) keeps `ceil()` and `max(min, …)` for every pool, so it equals the numeric total at the operating point but is piecewise:

  ```
  = 43.979 * rate_upload + 28.032 * (rate_upload + rate_download) + 1.0512 * rate_download + 16.425 + 78.183 * max(2, ceil(0.000714286 * (1.00557 * rate_upload + 4 * rate_find)), ceil(0.215535 * rate_upload)) + 119.136 * max(3, …)
  ```

- **`--mode relaxed`** drops pool rounding and minimum sizes, so it is linear in the rates and comes out below the numeric total (here by the $383 of minimum-size and rounding tax).
- **`--keep`** chooses the symbols: `rate.<request>`, `<request>.<attr>`, `gauge.<name>` or a param name. With `--keep rate.upload,upload.bytes` the result shows how upload size enters: linearly through transfer, LCUs and CPU, and through `ceil()` in S3's multipart PUT count (`ceil()` in billing expressions stays, even in relaxed mode):

  ```
  = rate_upload * (5.60639e-5 * upload_bytes + 13.14 * ceil(5.96047e-8 * upload_bytes) + 47.6902) + 5804.58 + 0.0648889 * (2.01114 * rate_upload * (2e-6 * upload_bytes + 3) + 324.144)
  ```

Symbols are in base units: req/s, bytes. Closed forms price each dimension at its effective rate at the operating point, so tiers never enter the algebra.

### `pricesim sweep`: a grid of scenarios

```sh
pnpm cli sweep examples/guide-example.ts --var rate.upload=10..160:log:5
```

```
uploads: 5 points over rate.upload

         rate.upload      total/mo        idle
                  10     $7,116.46     $458.12
                  20     $7,993.13     $495.14
                  40     $9,744.65     $569.19
                  80    $13,277.71     $795.45
                 160    $20,265.63   $1,169.81
```

A spec is `a..b[:log][:n]` (n points, default 10) or a comma list. Variable names are the same as for `--keep`, in base units. Setting `rate.<request>` rescales that request's series to the new mean, keeping its shape. Several `--var`s form a cartesian product; `--csv` adds one column per billing dimension and per pool:

```sh
pnpm cli sweep examples/guide-example.ts --var rate.upload=10,40 --var upload.bytes=100000,1000000 --csv
```

```
rate.upload,upload.bytes,total,used,idle,fixed,dim:aws.ec2.m7g.xlarge.hours,dim:aws.ec2.r7g.large.hours,…,pool:general,pool:search-nodes,pool:uploads-api
10,100000,6892.2,6409.4014,466.37366,16.425,357.408,234.549,…,3,3,2
10,1000000,7396.776,6914.5135,465.83754,16.425,357.408,234.549,…,3,3,2
40,100000,8847.626,8252.4627,578.73833,16.425,357.408,703.647,…,3,9,2
40,1000000,10865.93,10272.911,576.59388,16.425,357.408,703.647,…,3,9,2
```

### `pricesim capacity`: how far a fixed deployment goes

```sh
pnpm cli capacity examples/guide-example.ts --fix uploads-api=10
```

```
uploads: capacity with uploads-api=10

  12.410× the scenario's rates; runs out of cpu on uploads-api

  upload                      245.8 req/s (mean)
  download                   2469.9 req/s (mean)
  find                        620.5 req/s (mean)

  cost at capacity: $93,903.05/month (idle $1,507.24)
```

`--fix` pins pools (instance pools, pod groups or node pools, by name) at a size. The command scales the request rates together by a factor, found by bisection, until a pinned pool would need more than its size, and names the pool and resource that run out. `--scale` scales only some request types. Gauge-driven demand counts too; the `files` gauge follows the upload rate:

```sh
pnpm cli capacity examples/guide-example.ts --fix uploads-api=10,search-nodes=4 --scale upload
```

```
uploads: capacity with uploads-api=10, search-nodes=4

  0.937× the scenario's rates; runs out of memory on search-nodes

  upload                       18.6 req/s (mean)

  cost at capacity: $7,811.08/month (idle $434.17)
```

A factor below 1 means the pinned size is already too small for today's load: four search nodes can't hold the index of 30 days of uploads at 20/s.

## 4. Reading the cost tree

Every dollar in the tree is in exactly one of three top-level buckets, and `total = used + idle + fixed`:

| Bucket  | Where                                             | What it is                                                                   |
| ------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `used`  | the root node's branch (or one branch per tenant) | Cost driven by requests and gauges                                           |
| `idle`  | `idle/<pool>/…`                                   | Capacity that is provisioned but not used: minimum sizes, headroom, off-peak |
| `fixed` | `fixed/<node>/…`                                  | Time-based charges that accrue whatever the load                             |

**The used branch** follows the call graph: service → request → dependency → its request → … → billing dimension. A pool appears as a child of the request that used it (`uploads/download/uploads-api` is the node-hours that downloads' CPU used). Gauge-driven cost sits under `gauges`: `uploads/gauges/s3:files/gauges/stored/aws.s3.standard.storage` is the files' storage, and `uploads/gauges/search/gauges/search-nodes` is the search memory they hold. Cross-AZ transfer sits under `cross-az` in the request that declared the edge.

**Pools are charged by what was used of their binding resource.** A request is charged `resource-seconds used / per-instance capacity` instance-hours of that resource, and the rest of the provisioned instance-hours is idle. So:

- Search is **memory-bound**. Pool cost is attributed by **dominant share**: each request or gauge path pays for the largest fraction of an instance it uses across all resources. So the gauge holding the index pays for the memory, and `find → search.lookup` still pays for the CPU it uses (`search $7.82` under `find`). The rest sits in `idle/search-nodes/headroom`.
- **Instance pools** have one idle line, `headroom`: provisioned instance-hours minus used ones. It covers the minimum-size tax, the gap left by `loadFactor`, rounding up, and off-peak hours.

**Node pools** split idle into three lines, all in node-hours of the binding resource (CPU when the pool is at its minimum):

- **`pod headroom: <group>`**: resources requested by a pod group's replicas but not used by requests. It comes from `minReplicas`, `targetUtilization`, rounding and off-peak.
- **`system overhead`**: the `reserved` per-node capacity for the kubelet and daemonsets.
- **`node slack`**: allocatable capacity that no pod requested, from the node pool's `min`, `packingEfficiency` and rounding.

In the example, the `general` node pool is at its minimum of 3 nodes (12 vCPU) while the 2 `uploads-api` pods request 2 vCPU in total, so most of the node pool's $357/month is `node slack`. That is the signal to shrink the pool or share it with more services.

**Dimensions list.** `--json` adds a `dimensions` list: monthly `usage` in the dimension's unit, `listCost` from the schedule, `cost` after the region multiplier and discounts, and the `effectiveRate` actually charged. For tiered and free-tier dimensions, compare `effectiveRate` with the list rate: `example.queue.requests` pays less than $0.40/M because the first million requests are free.

**Pools list.** Each pool reports its `count`, `min`, `binding` (`cpu`, `memory`, `network`, `min`, or `maxPods` for node pools), and per resource the `peak` and `mean` demand and the provisioned `capacity`, in base units (millicores, bytes, bytes/s). For pod groups `capacity` is the requested amount; for node pools `peak` and `mean` are the summed pod requests.

## 5. Pitfalls

**Core·ms vs millicore·ms.** `pool.cpu()` takes CPU time per request, with dimension millicore·s. One millisecond of one core is `q(1, u.vCPU.mul(u.ms))`, which equals 1000 millicore·ms. Writing `q(40, u.millicore.mul(u.ms))` for "40 ms of CPU" type-checks but is 1000× too small: it evaluates to 0.04 millicore·s instead of 40. Define `const coreMs = u.vCPU.mul(u.ms)` once and use it everywhere.

**Peak vs mean.** Capacity is sized for the peak step (`peak: 'max'` by default, or `{ percentile: 99 }`); usage is billed on the integral. A diurnal series with `peakToMean: 2` needs twice the capacity of its mean. Two more details:

- The default period is 730 hours, which is not a whole number of days, so a diurnal series' mean over the period is not exactly the nominal mean: the example's uploads average 19.80/s, not 20/s. This is why `pricesim sweep --var rate.upload=20` gives $7,993.13 and not the scenario's $7,979.03. Use `series.constant` or a period of whole days when you need exact means.
- Capacity sizing adds the demand of each request type step by step, so peaks that coincide in time add up. Closed forms assume all peaks coincide.

**Minimum sizes dominate small workloads.** Every pool reachable from the root is provisioned at least at its minimum, even if no request uses it, and fixed charges accrue regardless. At low rates the all-in unit cost is mostly idle (see `find` in `pricesim unit-cost`: $0.07/M used, $2.02/M all-in). Relaxed closed forms drop minimums on purpose; exact ones and `evaluate()` keep them.

**Attributes are unit-checked at service boundaries.** A request's attributes are checked against the callee's declared units: at compile time for typed code, and at runtime (`.as(unit)`) for values from JSON or `parseQuantity`. A missing attribute is an error too. The runtime error names the units, not the call site:

```
UnitError: unit mismatch in as(byte): req vs byte
```

so search for the attribute whose declared unit is in the message.

**Levels vs rates.** `cpu()` and `network()` are per request; `memory()` is a level and belongs in `gaugeUse`. Putting `memory()` in a request's `use` throws. Gauge-driven memory has no rate behind it, so its cost is attributed under `gauges`, not under any request.

**`ceil` and `floor` work in base units.** `ceil(r.bytes.div(q(16, u.MiB)))` is right: the argument is dimensionless. `ceil(q(2.5, u.KB))` rounds 2500 bytes, not 2.5 KB.

**Edges need `interAz`.** A request with `net` edges fails with `… declares network edges but the scenario has no interAz dimension` unless the scenario sets `interAz`. Edges add network demand to pools only when given `from`/`to` ends.

**One object per billing dimension.** Dimensions are pooled by id. Two different dimension objects with the same id are an error, so define a dimension once and share it.

**Names.** Pool names are how `pricesim capacity --fix` and the `pools` report refer to pools, so keep them unique across the model. `gauges` and `$node` are reserved and can't be request type names.

**Months.** Results are always per month (730 hours). A workload with a different period is scaled to one month before tiers are applied.
