---
title: Pitfalls
summary: Mistakes that are easy to make, and how to spot them.
order: 11
---

**Core·ms vs millicore·ms.** `pool.cpu()` takes CPU time per request (millicore·s). One millisecond of one core is `q(1, u.vCPU.mul(u.ms))`. `q(40, u.millicore.mul(u.ms))` type-checks but is 1000× too small. Define `const coreMs = u.vCPU.mul(u.ms)` once.

**Undeclared demand is free.** A pool is sized only on what requests and gauges declare. If a pool comes out at its minimum under heavy load, check `binding` in `pricesim eval`: `min` means nothing you declared pushed it up.

**Peak vs mean.** Capacity is sized for the peak step; usage is billed on the integral. A diurnal series with `peakToMean: 2` needs twice the capacity of its mean. Peaks of different request types add up step by step, so coinciding peaks cost more; closed forms assume all peaks coincide.

**730 hours.** A month is 730 hours, not a whole number of days, so a diurnal series averages slightly off its nominal mean over the period (19.80/s for a nominal 20/s). Use `series.constant` when you need an exact mean.

**Minimum sizes dominate small workloads.** Every pool reachable from the root is provisioned at its minimum even if nothing uses it, and fixed charges accrue regardless. Compare "$/M used" with "$/M all-in" in `pricesim unit-cost` to see the minimum-size tax.

**Levels vs rates.** `cpu()`, `network()`, `ebsBandwidth()`, `ebsIops()` are per request; `memory()` and `disk()` are levels and belong in `gaugeUse`. A level in a request's `use` throws.

**`ceil` and `floor` work in base units.** `ceil(r.bytes.div(q(16, u.MiB)))` is right (dimensionless argument); `ceil(q(2.5, u.KB))` rounds 2500 bytes.

**Edges need `interAz`.** A request with `net` edges fails unless the scenario sets `interAz`. Edges add network demand to pools only when you give them `from`/`to`.

**One object per billing dimension.** Dimensions pool by id; two objects with the same id are an error. Define a dimension once and share it.

**Names.** Pool names are how `pricesim capacity --fix` and the pools report refer to pools: keep them unique. `gauges` and `$node` are reserved request names.

**Unit errors from untyped input** name the units, not the call site: `UnitError: unit mismatch in as(byte): req vs byte`. Look for the attribute whose declared unit is in the message.

**Tenants and analysis.** `unitCosts`, `closedForm`, `sweep` and `capacity` don't take multi-tenant scenarios; use `withWorkload` or evaluate tenants with `evaluate()`.

**Placeholders.** Inputs like CPU per request, compression or throughput per node are usually guesses. Make them `param(…)`s, sweep them, and say in results which numbers are measured.
