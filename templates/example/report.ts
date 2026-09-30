// Price, cost and margin by customer size, then over a simulated customer base sharing one deployment.
// Run: tsx report.ts
import { evaluate, normal, pricing, scenario, simulateTenants } from 'pricesim'
import { interAz } from 'pricesim/aws'
import { customer, events, prices } from './model.ts'

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`)
const discounts = pricing({ familyDiscounts: { 'aws.ec2': 0.25 } })

// 1. One customer on a dedicated deployment, at increasing size: where do minimum sizes stop dominating?
console.log('## One customer, dedicated deployment\n')
console.log('| MB/s | price /mo | cost /mo | margin | idle share of cost | storage nodes |')
console.log('|---|---|---|---|---|---|')
for (const mbps of [1, 5, 20, 50, 200]) {
  const r = evaluate(
    scenario({
      name: `events-${mbps}`,
      root: events,
      workload: customer(mbps),
      pricing: discounts,
      interAz,
      priceBook: prices,
    }),
  )
  const rv = r.revenue!
  const nodes = r.pools.find((p) => p.name === 'storage-nodes')!
  console.log(
    `| ${mbps} | ${usd(rv.revenue)} | ${usd(rv.cost)} | ${pct(rv.marginRate)} | ${pct(r.idle / r.total)} | ${nodes.count} (${nodes.binding}) |`,
  )
}

// 2. 40 customers sharing one deployment; sizes are lognormal (median 0.5 MB/s, a long tail of large ones).
const tenants = simulateTenants({
  count: 40,
  seed: 7,
  make: ({ rng }) => customer(0.5 * Math.exp(1.5 * normal(rng))),
})
const shared = evaluate(
  scenario({ name: 'events-shared', root: events, tenants, pricing: discounts, interAz, priceBook: prices }),
)
const rv = shared.revenue!
console.log(`\n## 40 customers, one shared deployment\n`)
console.log(`Revenue ${usd(rv.revenue)}/mo, cost ${usd(rv.cost)}/mo, margin ${pct(rv.marginRate)}.\n`)
console.log('| customer | revenue /mo | cost /mo | margin |')
console.log('|---|---|---|---|')
const sorted = [...rv.customers].sort((a, b) => b.revenue - a.revenue)
for (const c of [...sorted.slice(0, 5), ...sorted.slice(-3)])
  console.log(`| ${c.id} | ${usd(c.revenue)} | ${usd(c.cost)} | ${pct(c.marginRate)} |`)
