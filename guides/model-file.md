---
title: The model file
summary: Skeleton of a model file the CLI can run; project setup; how to iterate.
order: 2
---

A model file is a TypeScript module whose **default export** (or export named `scenario`) is a `scenario(…)`. The CLI type-checks it with the nearest `tsconfig.json`, loads it and runs the command.

## Project setup

```sh
mkdir my-model && cd my-model
pnpm init
pnpm add pricesim            # or: pnpm add github:addisonj/pricesim
pnpm add -D typescript tsx @types/node
```

`package.json` needs `"type": "module"`. A `tsconfig.json` that works:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

pricesim ships TypeScript sources, so run it with `tsx`: `pnpm exec pricesim eval model.ts`.

## Skeleton

```ts
import { pricing, q, scenario, series, u, workload } from 'pricesim'
import { gauge, instancePool, request, service } from 'pricesim/model'
import { ec2, interAz, s3Bucket } from 'pricesim/aws'

// units used below
const coreMs = u.vCPU.mul(u.ms)
const perSecond = u.req.div(u.s)

// 1. dependencies: offerings from the catalog (or your own)
const archive = s3Bucket('archive')

// 2. the root service: pools, request types, gauges
export const api = service('api', {
  deps: { archive },
  pools: { nodes: instancePool('api-nodes', { instance: ec2['c7g.xlarge'], min: 2, loadFactor: 0.7, azs: 2 }) },
  gauges: { objects: gauge(u.count) },
  requests: ({ deps, pools }) => ({
    write: request({ bytes: u.byte }, (r) => ({
      use: [pools.nodes.cpu(q(2, coreMs)), pools.nodes.network(r.bytes)],
      calls: [deps.archive.put({ bytes: r.bytes })],
    })),
  }),
  // every object is ~100 KB in S3
  gaugeMap: (g, { deps }) => [deps.archive.gauges.stored(g.objects.mul(q(100, u.KB.div(u.count))))],
})

// 3. the workload: rates over time, attributes, gauge levels
const typical = workload(api, {
  requests: {
    write: { rate: series.diurnal({ mean: q(50, perSecond), peakToMean: 1.5 }), attrs: { bytes: q(100, u.KB) } },
  },
  gauges: { objects: q(10_000_000, u.count) },
})

// 4. the scenario: what the CLI runs
export default scenario({ name: 'api', root: api, workload: typical, pricing: pricing(), interAz })
```

Check the request types and gauges of a catalog offering with `pricesim describe s3Bucket` before calling it.

## Iterating

- `pricesim eval model.ts`: does it run, what dominates, what binds each pool?
- Change one thing, re-run. `--no-typecheck` skips the type check for faster loops once the file checks.
- Export several scenarios from one file (named exports) for variants, and point the default export at the one you're working on; or write a small script that imports them and calls `evaluate()` on each.
- Keep inputs you're unsure of as `param(…)` so `pricesim sweep` can vary them without editing the file (`pricesim describe param`).
