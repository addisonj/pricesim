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

`sweep` varies one variable at a time (a grid over several), so it can't scale every request rate together. Write the workload as a function of scale and evaluate the variants:

```ts
// in the model: rates as a function of a traffic multiplier
export const traffic = (x: number) =>
  workload(api, {
    requests: {
      write: { rate: series.diurnal({ mean: q(200 * x, perSecond), peakToMean: 1.5 }), attrs: { bytes: q(1, u.KB) } },
    },
  })

// a script: today vs 5×
for (const x of [1, 5]) {
  const r = evaluate(scenario({ name: `x${x}`, root: api, workload: traffic(x), pricing: pricing(), interAz }))
  console.log(x, r.total.toFixed(0), r.pools.map((p) => `${p.name}=${p.count} (${p.binding})`).join(' '))
}
```

Report how the total scales (it's rarely 5×: minimums get absorbed, tiers get cheaper), and which pool or line grows fastest.

"Why is cross-AZ so large?"

```sh
pricesim eval model.ts --json | jq '.dimensions | sort_by(-.cost) | .[:5]'
pricesim closed model.ts --mode relaxed --keep rate.write,write.bytes
```

Read which edges carry the bytes (they sit under `cross-az` in the tree, per request type), then the per-byte coefficient in the closed form.
