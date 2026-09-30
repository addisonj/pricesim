# Spike: compile-time units (DESIGN.md §3.1)

**Result: adopt.** Tracking dimensions in TypeScript types costs very little check time, catches every mistake we tried, and gives readable errors once two small tricks are in place.

## What was built

- **`src/dim-typed.ts`:** about 25 lines of types. A dimension is a record of exponents over 8 base dimensions (USD, s, byte, req, op, millicore, count, stream). `Mul`/`Div` use generated lookup tables over −4…+4, and `Same<A, B>` is an exact-equality check.
- **`src/dim-untyped.ts`:** the same API with no dimension tracking, used as the baseline.
- **`src/core.ts`:** `Unit<D>`, `Expr<D>`, `q`/`sym`/`param`/`max`/`min`/`ceil`/`opaque`, the checked `.as()` boundary, and the model layer (`offering`, `service`, `request`, `pool`, `gauge`, `bill`). The runtime dimension check is always on.
- **`src/model.ts`:** a realistic model with 1 offering (S3 Express), 3 nested services (gateway → streamApi → logStore) and 20 parameterized request types. It also has typed sizing and cost relations, where `monthlyNodeCost` is checked to be `Expr<{USD: 1}>`, plus `opaque()` and a CLI boundary.
- **`src/catalog.gen.ts`:** 1,000 generated instance types with typed capacity vectors.
- **`src/errors.ts`:** 10 intentional mistakes.

## Results

`tsc --noEmit`, TypeScript 5.9.3, median of 3 runs:

| Model | Untyped check | Typed check | Typed instantiations |
|---|---|---|---|
| 1× (3 services, 20 requests, 1,000-instance catalog) | 0.24 s | 0.27 s | 35k |
| 10× (30 services, 200 requests) | 0.33 s | 0.41 s | 58k |

**Errors caught: 10 of 10.** They were:

1. GB + GB/s
2. `max(count, millicore)`
3. A count passed where a request attribute expects bytes
4. CPU given in millicore instead of millicore·s
5. A byte rate passed where bytes are expected
6. GB billed where the dimension expects GB·month
7. A wrong declared result type
8. An unknown dependency request
9. An exponent overflow
10. A missing request attribute

**Readability.** With the two fixes below applied, an error looks like this:

```
src/errors.ts(11,38): Argument of type 'Expr<{ millicore: 1; }>' is not assignable to parameter of type 'Expr<{ millicore: 1; }> & Mismatch<{ count: 1; }, { millicore: 1; }>'.
  Property ''unit mismatch'' is missing in type 'Expr<{ millicore: 1; }>' but required in type 'Mismatch<{ count: 1; }, { millicore: 1; }>'.
```

## Findings that change the design

1. **`Simplify<>` is required.** Without it, derived dimensions display as `Normalize<{ USD: 0; s: -1; byte: 1; req: 0; … }>`. With it they display as `{ s: -1; byte: 1 }`, and checking also got faster (63k → 35k instantiations).
2. **The dimension parameter must be invariant.** `Expr<D>` carries a phantom `(d: D) => D` field. Without it, `{byte: 1, s: -1}` would be assignable to `{byte: 1}`, because plain structural typing allows extra properties.
3. **Use `Same<>`-style parameters for public APIs.** These are `add`, `max`, `bill`, `pool.cpu` and so on. They produce an error naming the expected and actual dimensions ("unit mismatch: expected X, got Y"). Plain invariant parameters work too, but their errors are longer.
4. **`any` must not flow through `Expr<D>`.** Generic constraints on graph nodes need structural "shape" types, like `AnyCallable` in `core.ts`, not `Callable<any, any>`.
5. **Service requests are a function of the context:** `requests: ({ deps, pools }) => ({ append: request(...) })`. A per-request `(r, ctx)` signature can't be typed from the sibling `deps` property, because `request()` doesn't know the service's dependencies.
6. **Units are typed constants** (`u.GB.mul(u.month)`). Unit strings are only for untyped boundaries (CLI, JSON, generated data) and go through `parseQuantity(...).as(unit)`, which checks at runtime.
7. **Types track dimensions, not units.** KB, GB and GiB are all `{byte: 1}` and are converted at runtime, so mixing them is allowed and correct.
8. **Ergonomics:** plain numbers need `q(3, u.one)` today. Add `mul(n: number)` / `div(n: number)` overloads.
9. **`safe-units` isn't needed.** The machinery is small enough to own.
10. **Enforcement:** `tsx` doesn't type-check, so the CLI should run `tsc --noEmit` before loading a model. That costs about 0.3–0.5 s.

## Reproduce

```
npm install && npm run gen
npm run typed      # typed check + diagnostics
npm run untyped    # baseline
npm run errors     # the 10 intentional errors
npx tsx --tsconfig tsconfig.typed.json src/runtime.ts   # runtime checks
```
