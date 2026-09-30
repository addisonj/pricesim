// Pricing phase and cost tree (DESIGN.md §8, §8.1): price pooled usage per billing dimension, allocate the
// effective rate back to ledger entries, and fold them into a tree. Costs are reported in USD/month.
import { MONTH_SECONDS } from '../core/units.ts'
import { familyDiscount } from '../pricing/context.ts'
import { scheduleCost, type BillingDimension } from '../pricing/dimension.ts'
import { computeRevenue, type RevenueResult } from '../revenue/revenue.ts'
import { tenantsOf, type Scenario } from './scenario.ts'
import { DEFAULT_ACCOUNT } from './usage.ts'
import { collectUsage, type LedgerEntry, type PoolReport, type Seg } from './usage.ts'
import { doc, docs } from '../docs/registry.ts'

export interface DimensionCost {
  readonly id: string
  readonly family: string
  /** monthly usage in `unit` */
  readonly usage: number
  readonly unit: string
  /** list cost before region multiplier and discounts */
  readonly listCost: number
  readonly cost: number
  /** effective USD per `unit` after tiers, region multiplier and discounts */
  readonly effectiveRate: number
  readonly source?: string
  /** the payer, when the scenario bills to more than one account */
  readonly account?: string
}

export interface CostNode {
  readonly name: string
  readonly kind: Seg['kind'] | 'root' | 'dimension' | 'account'
  readonly cost: number
  readonly share: number
  /** leaf dimension nodes only */
  readonly usage?: number
  readonly unit?: string
  readonly children?: readonly CostNode[]
}

export interface Result {
  /** version of the JSON result format (schema/result.schema.json) */
  readonly schemaVersion: 1
  readonly scenario: string
  readonly description?: string
  readonly region: string
  readonly reportUnit: 'USD/month'
  readonly period: { readonly hours: number; readonly steps: number }
  readonly total: number
  /** cost driven by requests and gauges */
  readonly used: number
  /** provisioned but unused capacity (min-size tax, headroom, off-peak) */
  readonly idle: number
  /** time-based base charges */
  readonly fixed: number
  readonly tree: CostNode
  readonly dimensions: readonly DimensionCost[]
  readonly pools: readonly PoolReport[]
  /** multi-tenant scenarios: cost per tenant (idle and fixed allocated in proportion to used cost) */
  readonly tenants?: readonly TenantCost[]
  /** when charges land on more than one account (payer): cost per account */
  readonly accounts?: readonly AccountCost[]
  /** with a price book: revenue, the provider's cost and margin, in total, per meter and per customer */
  readonly revenue?: RevenueResult
}

export interface AccountCost {
  readonly name: string
  readonly total: number
  readonly used: number
  readonly idle: number
  readonly fixed: number
}

export interface TenantCost {
  readonly id: string
  /** cost driven by this tenant's requests and gauges */
  readonly used: number
  /** share of idle capacity and fixed charges, in proportion to used cost */
  readonly idleShare: number
  readonly fixedShare: number
  /** used + idleShare + fixedShare */
  readonly total: number
}

interface PricedEntry extends Omit<LedgerEntry, 'path'> {
  readonly cost: number
  readonly path: readonly (Seg | { readonly name: string; readonly kind: 'account' })[]
}

const accountCosts = (priced: readonly PricedEntry[]): AccountCost[] => {
  const m = new Map<string, { used: number; idle: number; fixed: number }>()
  for (const e of priced) {
    const a = m.get(e.account) ?? { used: 0, idle: 0, fixed: 0 }
    a[e.kind] += e.cost
    m.set(e.account, a)
  }
  return [...m].map(([name, a]) => ({ name, total: a.used + a.idle + a.fixed, ...a })).sort((x, y) => y.total - x.total)
}

const priceLedger = (s: Scenario, ledger: readonly LedgerEntry[], periodSeconds: number) => {
  // normalize to one billing month before applying tiers; tiers pool per account (as AWS bills them)
  const toMonth = MONTH_SECONDS / periodSeconds
  const multiAccount = new Set(ledger.map((e) => e.account)).size > 1
  const keyOf = (account: string, id: string) => `${account}|${id}`
  const byDim = new Map<string, { dim: BillingDimension; usage: number; account: string }>()
  for (const e of ledger) {
    const k = keyOf(e.account, e.dimension.id)
    const acc = byDim.get(k)
    if (acc && acc.dim !== e.dimension) throw new Error(`two different billing dimensions share id '${e.dimension.id}'`)
    byDim.set(k, { dim: e.dimension, usage: (acc?.usage ?? 0) + e.usage * toMonth, account: e.account })
  }
  const dims: DimensionCost[] = []
  const ratePerBase = new Map<string, number>()
  for (const [k, { dim, usage, account }] of byDim) {
    const units = usage / dim.usageUnit.scale
    const listCost = scheduleCost(dim.schedule, units)
    const cost =
      listCost *
      s.pricing.regionMultiplier *
      (1 - familyDiscount(s.pricing, dim.family)) *
      (1 - s.pricing.negotiatedDiscount)
    ratePerBase.set(k, usage > 0 ? cost / usage : 0)
    dims.push({
      id: dim.id,
      family: dim.family,
      usage: units,
      unit: dim.usageUnit.name,
      listCost,
      cost,
      effectiveRate: units > 0 ? cost / units : 0,
      ...(dim.source ? { source: dim.source.url } : {}),
      ...(multiAccount ? { account } : {}),
    })
  }
  const priced: PricedEntry[] = ledger.map((e) => ({
    ...e,
    cost: e.usage * toMonth * ratePerBase.get(keyOf(e.account, e.dimension.id))!,
    // with several payers, the tree's first level is the account
    ...(multiAccount ? { path: [{ name: e.account, kind: 'account' as const }, ...e.path] } : {}),
  }))
  dims.sort((a, b) => b.cost - a.cost)
  return { priced, dims, toMonth, multiAccount }
}

interface MutableNode {
  name: string
  kind: CostNode['kind']
  cost: number
  usage?: number
  unit?: string
  children: Map<string, MutableNode>
}

const buildTree = (name: string, entries: readonly PricedEntry[], toMonth: number): CostNode => {
  const root: MutableNode = { name, kind: 'root', cost: 0, children: new Map() }
  for (const e of entries) {
    let n = root
    n.cost += e.cost
    for (const seg of [...e.path, { name: e.dimension.id, kind: 'dimension' as const }]) {
      const key = `${seg.kind}:${seg.name}`
      let c = n.children.get(key)
      if (!c) {
        c = { name: seg.name, kind: seg.kind, cost: 0, children: new Map() }
        n.children.set(key, c)
      }
      c.cost += e.cost
      if (seg.kind === 'dimension') {
        c.usage = (c.usage ?? 0) + (e.usage * toMonth) / e.dimension.usageUnit.scale
        c.unit = e.dimension.usageUnit.name
      }
      n = c
    }
  }
  const total = root.cost
  const freeze = (m: MutableNode): CostNode => {
    const children = [...m.children.values()].sort((a, b) => b.cost - a.cost).map(freeze)
    return {
      name: m.name,
      kind: m.kind,
      cost: m.cost,
      share: total > 0 ? m.cost / total : 0,
      ...(m.usage !== undefined ? { usage: m.usage, unit: m.unit! } : {}),
      ...(children.length ? { children } : {}),
    }
  }
  return freeze(root)
}

export const evaluate = (s: Scenario): Result => {
  const usage = collectUsage(s)
  const { priced, dims, toMonth, multiAccount } = priceLedger(s, usage.ledger, usage.periodSeconds)
  const tree = buildTree(s.name, priced, toMonth)
  const sum = (k: LedgerEntry['kind']) => priced.filter((e) => e.kind === k).reduce((a, e) => a + e.cost, 0)
  const idle = sum('idle')
  const fixed = sum('fixed')
  const used = tree.cost - idle - fixed
  const tenantIds = s.tenants?.map((t) => t.id)
  const tenants = tenantIds?.map((id): TenantCost => {
    const u = priced
      .filter((e) => {
        // with several payers, paths start with the account
        const seg = e.path.find((x) => x.kind !== 'account')
        return e.kind === 'used' && seg?.kind === 'tenant' && seg.name === id
      })
      .reduce((a, e) => a + e.cost, 0)
    const share = used > 0 ? u / used : 1 / tenantIds.length
    return { id, used: u, idleShare: idle * share, fixedShare: fixed * share, total: u + (idle + fixed) * share }
  })
  const provider = s.account ?? DEFAULT_ACCOUNT
  const revenue = s.priceBook
    ? computeRevenue({
        book: s.priceBook,
        customers: tenantsOf(s),
        entries: priced.filter((e) => e.account === provider),
        singleId: s.name,
      })
    : undefined
  return {
    schemaVersion: 1,
    scenario: s.name,
    ...(s.description ? { description: s.description } : {}),
    region: s.pricing.region,
    reportUnit: 'USD/month',
    period: { hours: usage.periodSeconds / 3600, steps: usage.steps },
    total: tree.cost,
    used,
    idle,
    fixed,
    tree,
    dimensions: dims,
    pools: usage.pools,
    ...(tenants ? { tenants } : {}),
    ...(multiAccount ? { accounts: accountCosts(priced) } : {}),
    ...(revenue ? { revenue } : {}),
  }
}

doc({
  name: 'evaluate',
  kind: 'function',
  module: 'pricesim',
  summary: 'Evaluate a scenario: usage, pool sizing, pricing and the cost tree, in USD/month.',
  signature: 'evaluate(s: Scenario): Result',
  params: [{ name: 's', type: 'Scenario', doc: 'From `scenario(…)`; single-workload or multi-tenant.' }],
  returns: `A \`Result\` (all costs in USD per 730 h month; \`used + idle + fixed = total\`):
- \`total\`, \`used\` (driven by requests and gauges), \`idle\` (provisioned but unused pool capacity: minimum sizes, headroom, off-peak hours, node slack), \`fixed\` (time-based charges such as load-balancer hours).
- \`tree\`: a \`CostNode\` (\`name\`, \`kind\`, \`cost\`, \`share\` of total, \`children\`; dimension leaves also have \`usage\` and \`unit\` per month). Under the root: the root node → request type (or \`gauges\`) → called services/offerings and pools → billing dimensions; plus an \`idle\` branch (per pool) and a \`fixed\` branch. With tenants, each tenant's used cost sits under a \`tenant\` node; with several payers, the first level is the \`account\`. Children are sorted by cost.
- \`dimensions\`: one row per billing dimension (per account when there are several): monthly \`usage\` in \`unit\`, \`listCost\` (schedule and tiers only), \`cost\` (after region multiplier and discounts), \`effectiveRate\` (USD per unit), \`source\`. Sorted by cost.
- \`pools\`: per instance pool, pod group and node pool: \`count\`, \`min\`, \`binding\` (the resource that set the count, or \`min\` / \`maxPods\`), and per resource \`peak\`, \`mean\`, \`capacity\` in base units (millicore, byte, byte/s).
- \`tenants\` (multi-tenant only): per tenant \`used\`, \`idleShare\`, \`fixedShare\`, \`total\`, in scenario order.
- \`accounts\` (only when charges land on more than one payer): \`total\`, \`used\`, \`idle\`, \`fixed\` per account.
- \`revenue\` (with a \`priceBook\`): revenue, the provider account's cost, and margin, in total, per meter and per customer.
- Also \`scenario\`, \`description\`, \`region\`, \`reportUnit\`, \`period\` (\`hours\`, \`steps\`), \`schemaVersion\`. JSON Schema: \`schema/result.schema.json\`.`,
  guidance: `
- **Pricing:** usage is scaled to one month, pooled per billing dimension and account, and priced on its schedule (tiers apply to the pooled total), then × region multiplier × (1 − family discount) × (1 − negotiated discount). Each line of the tree is charged at that dimension's effective (average) rate.
- **Sizing:** each pool is sized on the peak step (or the workload's \`peak\` percentile) of every resource it declares; see \`instancePool\`, \`pods\`, \`nodePool\`. Pools reachable from the root are provisioned at least at their minimum, used or not.
- **Tenants:** \`idleShare\` and \`fixedShare\` are split in proportion to each tenant's used cost (equally if no tenant has used cost).
- Throws on modeling errors: missing attributes, unit mismatches, demand on a resource a pool does not declare, network edges without \`interAz\`.
- For JSON output, \`roundResult\` rounds as \`pricesim eval --json\` does.`,
  examples: [
    `import { evaluate, pricing, q, scenario, series, u, workload } from 'pricesim'
import { instancePool, request, service } from 'pricesim/model'
import { ec2 } from 'pricesim/aws'

const web = instancePool('web', { instance: ec2['c7g.large'], min: 2, loadFactor: 0.7, azs: 2 })
const api = service('api', {
  pools: { web },
  requests: ({ pools }) => ({
    get: request({}, () => ({ use: [pools.web.cpu(q(5, u.vCPU.mul(u.ms)))] })),
  }),
})
const s = scenario({
  name: 'api',
  root: api,
  pricing: pricing(),
  workload: workload(api, {
    requests: { get: { rate: series.diurnal({ mean: q(500, u.req.div(u.s)), peakToMean: 1.5 }), attrs: {} } },
  }),
})

const r = evaluate(s)
console.log(r.total, r.idle / r.total) // USD/month, idle fraction
const pool = r.pools.find((p) => p.name === 'web')! // { count, binding: 'cpu' | 'min' | …, resources }`,
  ],
  seeAlso: ['scenario', 'roundResult', 'unitCosts', 'closedForm', 'sweep', 'capacity', 'eval'],
  guide: 'analysis',
})

/** Round numbers for stable, readable JSON (costs to cents-and-a-bit, others to 6 significant digits). */
export const roundResult = (r: Result): Result =>
  JSON.parse(
    JSON.stringify(r, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(6)) : v)),
  ) as Result

docs([
  {
    name: 'roundResult',
    kind: 'function',
    module: 'pricesim',
    summary:
      'A copy of a `Result` with every non-integer rounded to 6 significant digits, as `pricesim eval --json` writes it.',
    signature: 'roundResult(r: Result): Result',
    seeAlso: ['evaluate'],
  },
  {
    name: 'Result',
    kind: 'type',
    module: 'pricesim',
    summary:
      'The result of `evaluate`: `total`, `used`, `idle`, `fixed` (USD/month), `tree`, `dimensions`, `pools`, and optional `tenants`, `accounts`, `revenue`.',
    seeAlso: ['evaluate'],
    guide: 'analysis',
  },
])
