# pricesim

[![CI](https://github.com/addisonj/pricesim/actions/workflows/ci.yml/badge.svg)](https://github.com/addisonj/pricesim/actions/workflows/ci.yml)

Model what software costs to run on cloud infrastructure, and what to charge for it. You describe a system as TypeScript (the requests it serves, the capacity each uses, the cloud products it bills) plus a workload, and pricesim sizes the capacity at peak, prices every line of the bill, and folds the cost into a tree. Add a price book to get revenue and margin, per meter and per customer.

- **Units everywhere:** every quantity carries its unit, checked at compile time and at runtime.
- **Real bills:** cloud offerings are described by their actual billing dimensions (tiers, free tiers, commitments), with an AWS catalog generated from the AWS price list.
- **Composable:** services call offerings and other services to any depth; capacity is instance pools or Kubernetes node pools and pods.
- **Analyses:** cost trees, unit costs, closed-form cost formulas, sweeps, capacity headroom, and multi-tenant simulations with price books.

## Quickstart

```sh
npx pricesim init my-model --example
cd my-model
pnpm install
pnpm exec pricesim eval model.ts    # cost tree, pools, revenue and margin
pnpm report                         # price, cost and margin by customer size, and over a customer base
```

`init` without `--example` writes a minimal skeleton instead. The worked example models an event-ingestion service (ALB → pods on a shared Kubernetes cluster → a replicated storage tier on EC2 → S3) with a price book and a simulated customer base. Inside this repo it's `pnpm cli eval templates/example/model.ts` and `pnpm example`. [`docs/guide.md`](docs/guide.md) is a second, step-by-step example with its output explained.

To add pricesim to an existing project: `pnpm add pricesim` (plus `typescript` and `@types/node` for type checking). The latest unreleased code is `github:addisonj/pricesim#main`.

## Documentation lives in the CLI

The CLI documents the library and itself, so people and coding agents learn it the same way:

```sh
pricesim --help                # commands
pricesim guide [topic]         # how to write models: units, services, capacity, workloads, revenue, analysis, pitfalls
pricesim api [query]           # every export, one line each
pricesim describe <name>       # one export in full: parameters, guidance, examples (the examples compile)
pricesim <command> --help      # usage and options; --describe adds guidance and examples
```

- **API docs are inline:** each export is registered with `doc({ … })` next to its definition (`src/docs/registry.ts`). [`docs/api.md`](docs/api.md) is generated from them (`pnpm gen:api`).
- **Commands** are registered with their docs in `src/cli/`.
- **Guides** are markdown in [`guides/`](guides/).
- `test/docs.test.ts` fails if an export is undocumented, a cross-reference is dangling, or an example (in the API docs or the guides) doesn't compile.

## Claude Code skills

The repo is a Claude Code plugin with three skills that point the agent at the CLI for details:

| Skill               | For                                                            |
| ------------------- | -------------------------------------------------------------- |
| `pricesim-modeling` | Writing or changing a model                                    |
| `pricesim-analysis` | Answering cost questions with a model                          |
| `pricesim-pricing`  | Designing price books and testing margins over a customer base |

Install them with `/plugin marketplace add addisonj/pricesim`, then `/plugin install pricesim@pricesim`.

## Status

| Area                                                                                                                                                                                      | Status        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Units and dimensions (compile-time and runtime), expressions, params, opaque functions                                                                                                    | ✅            |
| Pricing: flat, tiered and free-tier schedules; region multiplier; family and negotiated discounts                                                                                         | ✅            |
| AWS catalog: EC2 (all current-generation types, RI/Savings Plan rates), EBS gp3, S3, S3 Express, DynamoDB, Aurora, ELB, NAT, PrivateLink, Direct Connect (incl. flat rate), data transfer | ✅            |
| Model: offerings, services, instance pools (+ volumes), k8s node pools and pods, custom resources, gauges, network edges, accounts                                                        | ✅            |
| Workloads: series, attribute distributions, derived gauges, tenants (Zipf, custom)                                                                                                        | ✅            |
| Evaluation: cost tree, unit cost, closed form, sweeps, capacity                                                                                                                           | ✅            |
| Price books: meters, charges, fees, minimums, discounts, plans; revenue and margin per customer                                                                                           | ✅            |
| More tenant-size distributions (lognormal, Pareto, mixtures)                                                                                                                              | ⏳ (PLAN 3.6) |
| Other clouds                                                                                                                                                                              | not started   |

The design is in [DESIGN.md](DESIGN.md) and the roadmap in [PLAN.md](PLAN.md).

## Development

```sh
pnpm install
pnpm check          # typecheck + tests (incl. type tests and docs checks) + format check
pnpm cli --help     # the CLI, from source
pnpm gen:api        # regenerate docs/api.md from the inline docs
pnpm gen:dim        # regenerate type-level exponent tables (src/core/dim-tables.gen.ts)
pnpm gen:aws        # refetch AWS prices and instance specs into src/catalog/aws/*.gen.ts (review the diff)
```

Requires Node ≥ 22 and pnpm. The npm package is compiled JavaScript; the repo runs from the TypeScript sources with tsx.

- **CI** (`.github/workflows/ci.yml`) runs `pnpm check` on Node 22 and 24, smoke-tests the CLI, runs `pricesim init --example` against the checkout and evaluates it, and checks `docs/api.md` is current.
- **Result schema:** `pricesim eval --json` output is specified by [`schema/result.schema.json`](schema/result.schema.json) (JSON Schema 2020-12, version 1).
- **Browser safety:** nothing under `src/` except `src/cli/` may import Node built-ins; `test/browser-safe.test.ts` enforces it.

### Working on pricesim from a model

Most changes come up while working on a model. Link the model to your checkout:

```sh
cd my-model
pnpm link ~/path/to/pricesim     # adds an `overrides` entry to pnpm-workspace.yaml; don't commit it
# edit pricesim, re-run the model: no build step, the model imports the TypeScript sources
pnpm unlink pricesim             # back to the pinned version
```

### Releases

`pnpm release:patch` (or `release:minor`) runs the checks, bumps `package.json`, tags `vX.Y.Z` and pushes. The tag triggers `.github/workflows/release.yml`, which checks again, **stages** the version on npm (trusted publishing: GitHub's OIDC token, no npm token) and creates a GitHub release. The version goes live when you approve it: `pnpm release:approve` lists staged versions, then `npm stage approve <stage-id>` (asks for 2FA). A compromised repo or workflow can stage a version but can't publish one.

- **Packing is pnpm's job:** the repo's `exports` and `bin` point at the TypeScript sources (so the repo, `pnpm link` and git dependencies need no build), and `publishConfig` swaps in the compiled `dist/` when pnpm packs. The workflow publishes that tarball with npm. To publish by hand, use `pnpm publish` (it runs the checks and the build first), never plain `npm publish` from the repo.
- The compiled CLI runs on plain Node and loads TypeScript model files with tsx's loader. CI packs the tarball, installs it with npm and runs the example.

## Layout

```
src/core/      dimensions, units, expressions (browser-safe)
src/pricing/   billing dimensions, schedules, pricing contexts
src/model/     offerings, services, pools, requests, gauges, network
src/workload/  workloads, series, distributions, tenants
src/eval/      evaluation, unit cost, closed form, sweep, capacity
src/revenue/   price books, revenue and margin
src/catalog/   the AWS catalog (generated prices in *.gen.ts)
src/docs/      the inline documentation registry
src/cli/       the pricesim CLI and its command docs
templates/     projects for pricesim init (minimal, example)
guides/        pricesim guide topics
skills/        Claude Code skills (.claude-plugin/ holds the plugin manifest)
docs/          worked example (guide.md) and the generated API reference (api.md)
schema/        JSON Schema for pricesim eval --json results
scripts/       code generators
test/          vitest runtime tests (*.test.ts) and type tests (*.test-d.ts)
```

## Conventions

- **Units:** model code uses typed unit constants, e.g. `q(0.16, u.USD.div(u.GB.mul(u.month)))`. Unit strings are only for untyped boundaries, narrowed with `.as(unit)`, which checks at runtime.
- **Dimensionless factors:** number overloads, e.g. `.mul(3)`.
- **Generated files** (`*.gen.ts`, `docs/api.md`) are checked in and never edited by hand.
- **New exports** get a `doc({ … })` entry next to them; new commands are registered with `command({ … })`.

## License

[Apache-2.0](LICENSE).
