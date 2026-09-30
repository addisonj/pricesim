// A scenario ties a root node, a workload (or several tenants' workloads) and a pricing context together
// (DESIGN.md §7, §8).
import type { PricingContext } from '../pricing/context.ts'
import type { BillingDimension } from '../pricing/dimension.ts'
import type { AnyCallable } from '../model/node.ts'
import type { Workload } from '../workload/workload.ts'
import type { Plan, PriceBook } from '../revenue/price-book.ts'
import { doc, docs } from '../docs/registry.ts'

/** One tenant of a shared deployment: its own workload against the same root node. */
export interface Tenant {
  readonly id: string
  readonly workload: Workload
  /** the tenant's choices under the scenario's price book */
  readonly plan?: Plan
}

interface ScenarioBase {
  readonly name: string
  readonly description?: string
  readonly root: AnyCallable
  readonly pricing: PricingContext
  /** billing dimension for cross-AZ transfer; required if any request declares network edges */
  readonly interAz?: BillingDimension<{ byte: 1 }>
  /**
   * The payer for everything not assigned otherwise (default 'provider'). Nodes can bill to another
   * account with `account: '…'` (e.g. 'customer'); their dependencies inherit it.
   */
  readonly account?: string
  /** what the provider charges (revenue and margin in the result) */
  readonly priceBook?: PriceBook
  /** a single-workload scenario's plan under the price book (tenants carry their own) */
  readonly plan?: Plan
}

export type Scenario = ScenarioBase &
  (
    | { readonly workload: Workload; readonly tenants?: undefined }
    /** multi-tenant: capacity is sized on the tenants' combined demand; cost is attributed per tenant */
    | { readonly tenants: readonly Tenant[]; readonly workload?: undefined }
  )

export const scenario = (s: Scenario): Scenario => s

doc({
  name: 'scenario',
  kind: 'function',
  module: 'pricesim',
  summary: "What to evaluate: a root node, its workload (or tenants' workloads), pricing, and optionally a price book.",
  signature:
    'scenario(s: { name; description?; root; pricing; interAz?; account?; priceBook?; plan?; workload } | { …; tenants }): Scenario',
  params: [
    { name: 's.name', type: 'string', doc: 'Names the result and the root of the cost tree.' },
    { name: 's.description', type: 'string', optional: true, doc: 'Copied to the result.' },
    { name: 's.root', type: 'Service | Offering', doc: 'The node whose request types the workload drives.' },
    {
      name: 's.pricing',
      type: 'PricingContext',
      doc: '`pricing({ region?, regionMultipliers?, familyDiscounts?, negotiatedDiscount? })`.',
    },
    {
      name: 's.workload',
      type: 'Workload',
      doc: 'The load, from `workload(root, …)`. Give either `workload` or `tenants`.',
    },
    {
      name: 's.tenants',
      type: '{ id: string; workload: Workload; plan?: Plan }[]',
      doc: 'Several customers on one deployment, e.g. from `zipfTenants`. The list must be non-empty with unique ids, and all workloads need the same period and step.',
    },
    {
      name: 's.interAz',
      type: 'BillingDimension<byte>',
      optional: true,
      doc: 'Price of cross-AZ transfer (`interAz` from `pricesim/aws`). Required when a request that runs declares network edges; evaluation throws without it.',
    },
    {
      name: 's.account',
      type: 'string',
      optional: true,
      default: "'provider'",
      doc: "The payer for charges no node assigns elsewhere. Nodes with `account: '…'` (and their dependencies) bill to that account instead.",
    },
    {
      name: 's.priceBook',
      type: 'PriceBook',
      optional: true,
      doc: 'What the provider charges; adds `revenue` to the result.',
    },
    {
      name: 's.plan',
      type: 'Plan',
      optional: true,
      doc: "A single-workload scenario's choices under the price book (tenants carry their own `plan`).",
    },
  ],
  returns:
    'The same object, typed as a `Scenario`. Export it as the default export of a model file for the CLI, or pass it to `evaluate`, `unitCosts`, `closedForm`, `sweep` or `capacity`.',
  guidance: `
- **Tenants:** pools are sized on the tenants' combined demand; the tree gets a branch per tenant and \`result.tenants\` splits idle and fixed cost in proportion to used cost. Pool capacities and pod requests that use \`param(…)\` are bound with the **first** tenant's params, and its \`peak\` setting is used.
- Only \`evaluate\` supports tenants. \`unitCosts\`, \`closedForm\`, \`sweep\`, \`withOverrides\` and \`capacity\` throw on a multi-tenant scenario; use \`withWorkload(s, tenant.workload)\` to analyse one tenant alone.
- The CLI loads the model file's default export, or an export named \`scenario\`.`,
  examples: [
    `import { bill, dimension, evaluate, pricing, q, request, scenario, series, service, u, workload } from 'pricesim'
import { interAz } from 'pricesim/aws'

const ops = dimension('api.ops', u.op, 1e-6)
const api = service('api', {
  requests: () => ({ call: request({}, () => ({ bill: [bill(ops, q(1, u.op))] })) }),
})
const typical = workload(api, {
  requests: { call: { rate: series.constant(q(100, u.req.div(u.s))), attrs: {} } },
})

export default scenario({
  name: 'api',
  root: api,
  workload: typical,
  pricing: pricing({ region: 'us-east-1', negotiatedDiscount: 0.1 }),
  interAz,
})`,
  ],
  seeAlso: ['workload', 'zipfTenants', 'evaluate', 'pricing', 'priceBook', 'eval'],
  guide: 'workloads',
})

/** The scenario's workloads, tagged with tenant ids when multi-tenant. */
export const tenantsOf = (
  s: Scenario,
): readonly { readonly id?: string; readonly workload: Workload; readonly plan?: Plan }[] => {
  if (s.tenants) {
    if (!s.tenants.length) throw new Error(`${s.name}: tenants must not be empty`)
    const ids = new Set<string>()
    for (const t of s.tenants) {
      if (ids.has(t.id)) throw new Error(`${s.name}: duplicate tenant id '${t.id}'`)
      ids.add(t.id)
    }
    const [first, ...rest] = s.tenants
    for (const t of rest) {
      const w = t.workload
      if (w.periodSeconds !== first!.workload.periodSeconds || w.stepSeconds !== first!.workload.stepSeconds) {
        throw new Error(`${s.name}: tenant '${t.id}' has a different period/step than '${first!.id}'`)
      }
    }
    return s.tenants
  }
  return [{ workload: s.workload, ...(s.plan ? { plan: s.plan } : {}) }]
}

/** The single workload of a single-tenant scenario (for analyses not yet tenant-aware). */
export const singleWorkload = (s: Scenario, what: string): Workload => {
  if (!s.workload)
    throw new Error(`${what}: multi-tenant scenarios are not supported yet; evaluate them with evaluate()`)
  return s.workload
}

/** A copy of the scenario with a single workload (replacing any tenants). */
export const withWorkload = (s: Scenario, workload: Workload, name?: string): Scenario => {
  const { tenants: _t, workload: _w, ...base } = s
  return { ...base, ...(name ? { name } : {}), workload }
}

docs([
  {
    name: 'Scenario',
    kind: 'type',
    module: 'pricesim',
    summary: 'A scenario: `{ name, root, pricing, workload | tenants, … }`. Build it with `scenario(…)`.',
    seeAlso: ['scenario'],
  },
  {
    name: 'Tenant',
    kind: 'type',
    module: 'pricesim',
    summary: 'One tenant of a shared deployment: `{ id, workload, plan? }`.',
    seeAlso: ['scenario', 'zipfTenants'],
  },
  {
    name: 'tenantsOf',
    kind: 'function',
    module: 'pricesim',
    summary:
      "The scenario's workloads, tagged with tenant ids when multi-tenant; throws on empty tenants, duplicate ids, or differing period/step.",
    internal: true,
  },
  {
    name: 'singleWorkload',
    kind: 'function',
    module: 'pricesim',
    summary: 'The workload of a single-workload scenario; throws for a multi-tenant one.',
    internal: true,
  },
  {
    name: 'withWorkload',
    kind: 'function',
    module: 'pricesim',
    summary: 'A copy of the scenario with one workload (replacing any tenants), optionally renamed.',
    signature: 'withWorkload(s: Scenario, workload: Workload, name?: string): Scenario',
    guidance: `
- Use it to evaluate one tenant alone (a dedicated deployment), or to run the single-workload analyses on it.
- \`plan\` stays whatever the scenario has; a tenant's own \`plan\` is not carried over.`,
    examples: [
      `import { evaluate, withWorkload, type Scenario } from 'pricesim'

// cost of giving every tenant its own deployment
const dedicated = (shared: Scenario) =>
  (shared.tenants ?? []).map((t) => evaluate(withWorkload(shared, t.workload, t.id)).total)`,
    ],
    seeAlso: ['scenario', 'evaluate'],
  },
])
