---
name: pricesim-modeling
description: Write or change a pricesim cost model (TypeScript) of a system on cloud infrastructure — services, capacity pools, cloud offerings, workloads and scenarios. Use when the user wants to model what a system costs to run, add a component or cloud product to a model, or fix a model that errors or gives implausible numbers.
---

# Writing pricesim models

pricesim is self-documenting: the CLI has the reference, the guides and the examples. **Look things up before writing code; don't guess signatures.**

```sh
pricesim guide                 # topics; start with: pricesim guide overview, then model-file
pricesim guide <topic>         # units, offerings, catalog, services, capacity, workloads, revenue, analysis, pitfalls
pricesim api <word>            # find an export
pricesim describe <name>       # parameters, guidance, examples that compile
```

Run it as `npx pricesim …` in a project that depends on pricesim, or `pnpm cli …` inside the pricesim repo.

## Rules

1. **Read before writing.** Before using a function or catalog offering for the first time, run `pricesim describe <name>`. For catalog offerings it lists the request types and gauges you can call (e.g. `put({ bytes })`, `gauges.stored`), which you can't infer from the name.
2. **Every quantity has a unit.** `q(value, unit)`, never bare numbers; build units with `.mul`/`.div`. Define `const coreMs = u.vCPU.mul(u.ms)` for CPU time (a millicore·ms is 1000× smaller). Count custom things with `baseUnit('partition')`.
3. **Model what binds.** A pool is sized only on declared demand. For data systems that is usually network, disk or a software limit (custom resources), not CPU. After `pricesim eval`, check each pool's `binding`: `min` under heavy load means demand is missing.
4. **Uncertain inputs are params.** CPU per request, throughput per node, compression ratios, replication factors: `param('name', q(…))`, so they can be swept (`pricesim sweep --var name=…`) and overridden without editing code. Say in a comment where each number comes from (measured, vendor spec, guess).
5. **Keep the graph honest.** Offerings for cloud products, services for code, dependencies via `deps` and calls. Cross-AZ traffic via `edge(…)` (and set `interAz` on the scenario). Resources in someone else's account get `account: 'customer'`, so they don't count as your cost.
6. **Type-check and run after every change**: `pricesim eval model.ts`. The CLI type-checks first; fix type errors (they are usually unit mismatches) instead of casting them away.
7. **Sanity-check the numbers** against a hand calculation for the biggest line (e.g. GB/month × $/GB), and against the list price in `pricesim describe <offering>`.
8. **Don't edit generated files** (`*.gen.ts`), and don't hard-code prices a catalog entry already has.

## Workflow

1. For a new project, start with `pricesim init <dir>` (`--example` shows most features in one model).
2. Sketch the system: the root service and its request types, the capacity each uses, the cloud products it calls, what it stores (gauges).
3. Start from the skeleton (`pricesim guide model-file`); add one component at a time, running `pricesim eval` each time.
4. Write the workload from the user's numbers (rates, sizes, peak-to-mean, retention); derive stored data from rates with `retained(…)` so it scales in sweeps.
5. Report the result with its assumptions (`pricesim guide analysis`).

## Example: adding a component

The user asks to add a Redis cache in front of a database, with a 90% hit rate:

```sh
pricesim api cache          # nothing: no managed cache in the catalog
pricesim describe instancePool
pricesim describe ec2       # how to pick an instance type
```

```ts
const cacheNodes = instancePool('cache', { instance: ec2['r7g.large'], min: 2, loadFactor: 0.6, azs: 2 })
const cache = service('cache', {
  pools: { nodes: cacheNodes },
  gauges: { keys: gauge(u.byte) },
  requests: ({ pools }) => ({ get: request({}, () => ({ use: [pools.nodes.cpu(q(0.05, coreMs))] })) }),
  gaugeUse: (g, { pools }) => [pools.nodes.memory(g.keys)],
})
// in the caller: every read hits the cache; 10% miss and go to the database
calls: [deps.cache.get({}), deps.db.read({ bytes: r.bytes }).times(0.1)],
```

Then `pricesim eval`, and check that the cache pool binds on memory at the expected size.
