---
title: Units and expressions
summary: Expr, units, custom dimensions, params and symbols; unit errors.
order: 3
---

Every quantity is an `Expr<D>`: a symbolic expression whose dimension `D` is tracked by the TypeScript type **and** by a runtime exponent vector. Adding bytes to bytes/s is a compile error, and a runtime `UnitError` for values that came from untyped input.

## Rules

- **Build quantities with `q(value, unit)`**, never bare numbers: `q(500, u.KB)`, `q(0.023, u.USD.div(u.GB.mul(u.month)))`.
- **Compound units** with `.mul()` / `.div()` on units: `u.req.div(u.s)`, `u.vCPU.mul(u.ms)`.
- **Dimensionless factors** are plain numbers: `.mul(3)`, `.div(2)`.
- **Values are stored in base units** (bytes, seconds, millicores, USD). `e.eval()` gives base units; `e.in(u.GB)` converts.
- **Built-in base dimensions:** `USD`, `s`, `byte`, `req`, `op`, `millicore`, `count`, `stream`. Anything else you count gets its own with `baseUnit('partition')`.
- **Untyped boundaries** (JSON, CLI strings): `parseQuantity('5000 req/s').as(u.req.div(u.s))`; `.as(unit)` checks the dimension at runtime.

```ts
import { baseUnit, ceil, max, param, q, u } from 'pricesim'

const partition = baseUnit('partition')
const perSecond = u.req.div(u.s)
const coreMs = u.vCPU.mul(u.ms) // CPU time: 1 core·ms = 1000 millicore·ms

const rate = q(5000, perSecond)
const bytes = q(2, u.KB)
const throughput = rate.mul(bytes).div(q(1, u.req)) // Expr<byte/s>
const units = ceil(bytes.div(q(1, u.KiB))) // dimensionless: 2 (2000 B / 1024 B, rounded up)
const partitions = max(q(3, partition), q(1, partition).mul(ceil(throughput.div(q(10, u.MB.div(u.s))))))
const replication = param('replication', q(3, u.count)) // overridable by a workload or a sweep
```

## Symbols and params

- `param(name, default)` is a named constant a workload (`params: { name: … }`) or `pricesim sweep --var name=…` can override. Use it for every input you're unsure of (compression ratio, CPU per request, retention).
- `sym(name, unit)` is a free variable bound at evaluation time; the engine binds `rate.<request>` (mean request rates) and `time` itself. You rarely need `sym` directly: `meanRate('upload')` and `elapsed` are the typed forms.
- `opaque(name, { inputs, unit }, fn)` wraps a numeric function with no closed form (a lookup table, a simulation). Closed forms treat it as a black box.

## Pitfalls

- `ceil`/`floor` round the value **in base units**: `ceil(q(2.5, u.KB))` rounds 2500 bytes. Divide by the unit first: `ceil(x.div(q(1, u.KB)))`.
- `u.millicore.mul(u.ms)` is 1000× smaller than a core·ms. Define `coreMs` once.
- `u.month` is 730 hours; results are always per month.
- `baseUnit('x')` returns the same dimension from any module; built-in names can't be reused. `defineUnit('kstream', stream, 1000)` adds a scaled name that unit strings can parse.

Details: `pricesim describe q`, `pricesim describe u`, `pricesim describe param`, `pricesim describe baseUnit`.
