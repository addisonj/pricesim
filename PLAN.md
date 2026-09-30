# pricesim: implementation plan

*2026-09-24. Measured against DESIGN.md. Status legend: ✅ done · 🟡 partial · ⏳ not started.*

**Scope:** this is a general-purpose library and may be published on its own. Nothing specific to any one product goes in this repo: product models live with the product and import this library. Competitor price models are out of scope.

## Where we are

**Done:**
- **Units, expressions and pricing schedules.** Units are checked at compile time and at runtime. Price schedules can be flat, tiered or free-tier, with a region multiplier and discounts.
- **Model layer.** Offerings, services, instance pools, k8s node pools and pods, gauges, cross-AZ edges, and fixed charges.
- **Engine.** Usage ledger → sizing for peak → provisioning at minimum size → idle attribution → pricing → cost tree.
- **CLI.** `pricesim eval` and `pricesim unit-cost`.
- **Example.** `orders-platform`, with hand-verified tests and a golden JSON file.

**Since then:** symbolic usage, closed form, sweeps, capacity, derived gauges, the peak reducer, and new offerings (M2 and 1.4/1.5).

**Prior art (researched 2026-09-24):**
- Nothing in JS/TS does service composition with cost trees and closed forms. The nearest is `elecnix/infra-cost-model`, which is in Python.
- For EC2 (and RDS/ElastiCache) specs and prices, reuse Vantage's `ec2instances.info` data (MIT): baseline network, EBS specs, RI, Savings Plans and spot.
- For everything else, keep using AWS's public price files.

## Milestones

### M1: Trustworthy costs (catalog and missing resources)

Goal: stop hand-curating prices, and cover the AWS resources a streaming system actually uses.

| # | Item | Notes |
|---|---|---|
| 1.1 ✅ | Generated catalog: `scripts/fetch-aws-prices.ts` → `src/catalog/aws/*.gen.ts` | See the data sources below. Output is checked in and dated, so price changes show up as diffs. |
| 1.2 ✅ | Full EC2 catalog, including baseline network, EBS bandwidth/IOPS and local NVMe | The price list has no baseline network figure. Take it from `ec2 describe-instance-types`, or from the docs table as a checked-in snapshot. |
| 1.3 ✅ | EBS offering (gp3: GB-month, extra IOPS, throughput) attached to pools | `volume: { type: gp3, size, iops?, throughput? }` on instance and node pools: one per instance, billed per instance and split like instance-hours; adds to `disk`/`ebsIops`/`ebsBandwidth` capacity, capped by the instance's EBS limits. Snapshots and burst credits are not modeled. |
| 1.4 ✅ | S3 Express One Zone offering, with single-AZ placement | Placement is metadata (`placementOf`); the engine doesn't read it yet. The 512 KB threshold was removed by AWS in April 2025. |
| 1.5 ✅ | ALB/NLB (hours + LCU), NAT gateway, internet egress (tiered) | LCUs are billed from processed bytes only (a documented simplification). |
| 1.6 ✅ | Commitments from the catalog: RI and Savings Plan rates per instance type | `familyDiscount` stays as the fallback.  Open: rates are applied by hand (`ec2CommitmentDiscount` → `familyDiscounts['aws.ec2.compute']`), one fraction for every instance type; the per-dimension `commitments` option in DESIGN.md §5.5 would resolve each type's own rate. |
| 1.7 ✅ | Capacity dimensions: EBS bandwidth/IOPS and NVMe on instance pools. Pod network. Network edges add demand to the pools at both ends. | Resources `ebsBandwidth`, `ebsIops`, `disk` (NVMe + volume). Optional pod `request.network`. `edge(bytes, pattern, { from, to })`. Pool cost is attributed by dominant share over all resources. |
| 1.8 ✅ | Unit tests for engine internals (usage, sizing, allocation, pricing) | Today only the end-to-end example tests exercise them. |

**Data sources verified today:**
- **EC2:** `b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/...` (gzipped JSON, 58 KB per region and OS).
- **S3 and DynamoDB:** the same `meteredUnitMaps` source.
- **RDS/Aurora:** `pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.csv` (18 MB).
- **Avoid:** the per-region EC2 bulk offer file, which is very large.

### M2: Answer pricing questions (symbolic engine and analysis)

Goal: the closed forms and curves that pricing strategy needs, for example cost per stream as f(throughput, streams).

| # | Item | Notes |
|---|---|---|
| 2.1 ✅ | **Symbolic usage.** Request expansion emits `Expr` contributions over attribute, param and rate symbols, instead of numbers. Numeric evaluation binds them. | The architectural change. Everything below depends on it. It keeps the usage-then-price split (DESIGN §8.1). |
| 2.2 ✅ | CAS bridge (mathjs): relaxed mode (drop ceil and min-size), simplify, print with units | DESIGN §4. Tiers are priced at the operating point. |
| 2.3 ✅ | `pricesim closed <model> --quantity total --keep a,b` | |
| 2.4 ✅ | `pricesim sweep`: grid over rates, attributes, params and instance types, exported to CSV/JSON | Also a CSV export of the flattened cost tree. |
| 2.5 ✅ | `capacity()` / `pricesim capacity`: maximum sustainable rate for a fixed deployment | Symbolic solve if linear, otherwise bisection. |
| 2.6 ✅ | Gauges derived from rates (rate × retention, running integral) | The example currently hard-codes gauge levels. |
| 2.7 🟡 | Time-varying attributes, and a pluggable `peak(series)` reducer | Peak reducer done (max or percentile). Time-varying attributes are not done: expansion assumes constant attributes. |

### M3: Multi-tenant and distribution modeling

Goal: model a multi-tenant system by drawing workloads from distributions and aggregating them.

| # | Item | Notes |
|---|---|---|
| 3.1 ✅ | Tenants: `scenario({ tenants })` with per-tenant attribution | DESIGN §7. |
| 3.2 ✅ | Seeded distributions (`dist.*`) and Monte Carlo sampling for non-linear expressions | DESIGN §7. |
| 3.3 ✅ | Tenant simulator: draw tenants (e.g. Zipf-sized) with a mix of dimensions, then aggregate | Covers the minimum-size tax against pooled capacity. |
| 3.4 ✅ | Generic example scenarios: many small workloads vs one large one | These go in `examples/`, not tied to any product. |
| 3.5 ✅ | Price books: meters, charges (one meter → many), options and plans, fees, minimums, discounts; revenue and margin in total, per meter and per customer | DESIGN §8.2. Open: margin in `sweep`/`closedForm` (break-even solves), and a revenue view in the tenant simulator's summaries. |
| 3.6 | Tenant size distributions beyond Zipf: `lognormalTenants` (σ, rescaled so the largest hits a target), Pareto, and mixtures (e.g. a lognormal body with a Pareto top, or a separate small-customer cohort); a helper that calibrates σ from a "top X% carry Y%" share; repeated draws across seeds with mean and spread of results | Follow-up from simulating a customer base (2026-09-25): Zipf assigns sizes by rank, so with n tenants the smallest is always largest ÷ n^s and there is no tail of tiny customers. The model that found this has a local lognormal option and a separate cohort of tiny customers, which could move here. |

### M4: Usability

| # | Item |
|---|---|
| 4.1 ✅ | Model-authoring guide (README / `docs/`) using the example |
| 4.2 🟡 | TUI view of the cost tree, and a browser build of the core. The core is already free of Node dependencies; add a lint rule to keep it that way. |
| 4.3 | CI (once hosted): `pnpm check` plus a nightly price-drift check against the live price data |
| 4.4 ✅ | Versioned JSON result schema |

## Known limitations to keep in mind

- **Pool cost split is by dominant share.** Each request or gauge path pays max over resources of its share of the pool (DESIGN §6.2). It doesn't price resources differently (a CPU-second and a GB-second of memory at the same share cost the same), and when shares add up to more than the pool they are scaled down proportionally rather than negotiated.
- **Per-caller instances.** Shared dependencies are always one instance. The per-edge `dedicated()` option isn't implemented.
- **Edge demand is opt-in.** Edges add network demand only to the pools named in `from`/`to`, each end gets the full bytes, and there is no separate ingress/egress limit per direction.
- **Pod requests are cpu, memory and network.** Pods can't request disk or EBS; put those demands on an instance pool.
- **Unit cost evaluates each request alone.** It doesn't give marginal cost within a mixed workload; that comes with symbolic usage (2.1).
- **Month-based results.** Results are reported per month, and a period that isn't one month is scaled before tiers are applied.

**Found while modeling a streaming product:**
- **No pass-through for request types or gauges.** Wrapper services re-declare them and map them down by hand. Add a `passThrough()` helper or gauge forwarding.
- **Volume size is fixed per pool.** When disk binds, the engine adds instances; it can't choose a bigger volume.
- **Typing wrapper roots.** Wrappers with the same API need casts to share one workload builder.
- **No AZ placement model.** Cross-AZ traffic is an expected fraction per edge.
- **No fixed per-instance CPU reservation on instance pools**, like a node pool's `reserved`, for software that pins cores regardless of load.

## Decisions

1. **Order:** M2.1 (symbolic usage) first, with M1 items, engine tests and new offerings in parallel.
2. **Product models:** none in this repo; product models live in their own repos and import this library.
3. **Competitor price models:** out of scope.
4. **Hosting:** local git with clean commits for now; possibly published as a standalone library later.
