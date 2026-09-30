---
name: pricesim-analysis
description: Answer cost questions with a pricesim model — what it costs at a given scale, what drives cost, unit costs, how cost scales, how far a deployment goes, or how a design change or discount moves the bill. Use when the user asks about costs, cost drivers, COGS, scaling, or what-ifs for a system that has (or should have) a pricesim model.
---

# Analysing costs with pricesim

Each analysis is a CLI command with its own documentation. Read it before using a command for the first time:

```sh
pricesim guide analysis          # which command answers which question
pricesim <command> --describe    # eval, unit-cost, closed, sweep, capacity: options, how to read the output
```

Run it as `npx pricesim …` in a project that depends on pricesim, or `pnpm cli …` inside the pricesim repo.

## Rules

1. **Pick the tool for the question:**
   - _what does it cost / where does it go_ → `eval`;
   - _per request_ → `unit-cost`;
   - _how does it scale, which term dominates_ → `closed --mode relaxed`;
   - _numbers across a range_ → `sweep`;
   - _headroom of a fixed deployment_ → `capacity`.
   - For many scenarios (sizes, variants, seeds), write a small script that calls `evaluate()` in a loop and prints a table.
2. **Lead with the answer, then the drivers.** A number, then the two or three lines that make it up, with their share. Take them from the tree or the `dimensions` JSON (`eval --json`), not from memory.
3. **Separate used, idle and fixed.** At small scale idle (minimum sizes) often dominates; say so rather than reporting all-in as if it were marginal cost.
4. **State the assumptions that move the answer:** region, discounts (Savings Plans, negotiated cross-AZ), peak-to-mean, retention, compression, per-node throughput, and which inputs are guesses. If an input is a guess and the answer is sensitive to it, sweep it and show the range.
5. **Compare like for like.** Same workload, same retention, same redundancy, and the same billing basis (e.g. logical vs replicated bytes, list vs committed prices). When comparing against a vendor's price, check what exactly they bill for.
6. **Verify surprising results** before reporting: a hand calculation of the biggest line, the pool counts and binding resources, and the effective rate vs the list rate in `dimensions`.
7. **Don't fabricate precision.** Round to what the inputs support; label estimates as estimates.

## Examples

"What does this cost at 5× today's traffic?"

Give every rate the same multiplier param, then sweep it (`rate.<request>` sweeps one request type at a time; several `--var`s form a grid, not a joint scale):

```ts
// in the model
const traffic = param('traffic', q(1, u.one))
const typical = workload(api, {
  requests: {
    write: {
      rate: series.diurnal({ mean: q(200, perSecond).mul(traffic), peakToMean: 1.5 }),
      attrs: { bytes: q(1, u.KB) },
    },
    read: { rate: series.constant(q(500, perSecond).mul(traffic)), attrs: { bytes: q(1, u.KB) } },
  },
})
```

```sh
pricesim sweep model.ts --var traffic=1,2,5 --csv
```

Report how the total scales (it's rarely linear: minimums get absorbed, tiers get cheaper), and which pool or line grows fastest (the `pool:` and `dim:` columns).

"Why is cross-AZ so large?"

```sh
pricesim eval model.ts --json | jq '.dimensions | sort_by(-.cost) | .[:5]'
pricesim closed model.ts --mode relaxed --keep rate.write,write.bytes
```

Read which edges carry the bytes (they sit under `cross-az` in the tree, per request type), then the per-byte coefficient in the closed form.
