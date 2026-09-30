---
name: pricesim-pricing
description: Design and test what a product charges using pricesim price books — meters, tiers, fees, minimums, discounts, plans — and simulate revenue and margin per customer across a customer base. Use when the user is setting prices, checking margins, comparing price structures, or modeling how a customer population would be billed.
---

# Pricing with pricesim

Price books sit on top of a cost model: the same scenario gives cost (what you pay) and revenue (what you charge), and the margin per meter and per customer.

```sh
pricesim guide revenue          # meters, charges, fees, minimums, discounts, options and plans
pricesim describe priceBook     # every field, with examples
pricesim guide workloads        # tenants and simulated customer bases
```

Run it as `npx pricesim …` in a project that depends on pricesim, or `pnpm cli …` inside the pricesim repo.

## Rules

1. **Keep prices as an explicit table.** One exported object with the actual numbers (rate per tier, per meter) that builds the price book. People tune prices by editing numbers; don't derive them from multiplier arrays.
2. **Meter what customers understand** and what tracks your cost: request units of a fixed size (`ceil(bytes / unit)`), GB transferred, GB-months stored, resource-hours. Check each meter's margin separately; a meter sold below cost should be deliberate.
3. **Margin is the provider's.** Costs billed to the customer's own account (`account: 'customer'`) aren't yours; include them when comparing the customer's all-in cost with alternatives.
4. **Tiers, minimums and discounts apply per customer.** Test prices on a customer _population_ (tenants), not one average customer. Draw sizes from a skewed distribution (lognormal is a good default; Zipf has no tail of tiny customers), pool several seeds, and report medians and percentiles as well as means.
5. **Compare against alternatives on the same workload**, at the prices a customer would actually pay: list vs committed, the provider's production minimums, what their storage and transfer are billed on. Keep competitor price models in your own project, not in pricesim.
6. **Look at the whole curve.** Tabulate price, cost and margin by customer size (a sweep or a script over sizes); check where discounts or tiers make margin fall off, and where one offering or deployment model overtakes another.
7. **Report assumptions**: the cost-side discounts (they change margins a lot at scale), batching and compression assumptions that change billed units, and which prices are placeholders.

## Example

"What margin do we make on small vs large customers?"

1. Put the price book on the scenario (`priceBook`, and `plan` or per-tenant plans).
2. Build a population: `simulateTenants({ count, seed, make })`, drawing each tenant's size from `rng`.
3. `evaluate()` per seed; bucket `result.revenue.customers` by size; tabulate revenue, cost and margin per bucket.
4. Report: the margin per bucket, the share of revenue per bucket, the buckets below target margin, and which meter drives it (`revenue.meters`).
