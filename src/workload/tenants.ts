// Tenant simulation (DESIGN.md §7, PLAN 3.3): generate many tenants' workloads from seeded distributions,
// e.g. Zipf-sized tenants sharing one deployment.
import type { Tenant } from '../eval/scenario.ts'
import { rng, zipfWeights, type Rng } from './random.ts'
import type { Workload } from './workload.ts'
import { doc } from '../docs/registry.ts'

export interface TenantDraw {
  readonly id: string
  /** 0-based position; with `zipfTenants`, rank 0 is the largest tenant */
  readonly index: number
  /** an independent random stream for this tenant */
  readonly rng: Rng
}

/** `count` tenants, each built by `make` with its own seeded random stream. */
export const simulateTenants = (opts: {
  count: number
  seed?: number
  idPrefix?: string
  make: (t: TenantDraw) => Workload
}): Tenant[] => {
  const root = rng(opts.seed ?? 1)
  const prefix = opts.idPrefix ?? 'tenant-'
  const width = String(opts.count).length
  return Array.from({ length: opts.count }, (_, index) => {
    const id = `${prefix}${String(index + 1).padStart(width, '0')}`
    return { id, workload: opts.make({ id, index, rng: root.fork(id) }) }
  })
}

/**
 * `count` tenants whose sizes follow a Zipf distribution (rank r gets weight ∝ 1/r^exponent): `make`
 * receives the tenant's `share` of the total (shares sum to 1). The market pattern: a few large tenants,
 * a very long tail of small ones.
 */
export const zipfTenants = (opts: {
  count: number
  exponent?: number
  seed?: number
  idPrefix?: string
  make: (t: TenantDraw & { readonly share: number }) => Workload
}): Tenant[] => {
  const w = zipfWeights(opts.count, opts.exponent ?? 1)
  return simulateTenants({
    count: opts.count,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.idPrefix !== undefined ? { idPrefix: opts.idPrefix } : {}),
    make: (t) => opts.make({ ...t, share: w[t.index]! }),
  })
}

doc({
  name: 'simulateTenants',
  kind: 'function',
  module: 'pricesim',
  summary: 'Generate `count` tenants, each with a workload built by `make` from its own seeded random stream.',
  signature:
    'simulateTenants(opts: { count: number; seed?: number; idPrefix?: string; make: (t: TenantDraw) => Workload }): Tenant[]',
  params: [
    { name: 'opts.count', type: 'number', doc: 'Number of tenants.' },
    {
      name: 'opts.seed',
      type: 'number',
      optional: true,
      default: '1',
      doc: 'Root seed; each tenant forks its stream from it by id.',
    },
    {
      name: 'opts.idPrefix',
      type: 'string',
      optional: true,
      default: "'tenant-'",
      doc: 'Ids are the prefix plus a 1-based, zero-padded number: `tenant-001` … `tenant-200` for 200 tenants.',
    },
    {
      name: 'opts.make',
      type: '(t: { id; index; rng }) => Workload',
      doc: "Builds one tenant's workload. `index` is 0-based; `rng` is that tenant's own stream (`rng.next()` in [0, 1)).",
    },
  ],
  returns: '`Tenant[]` (`{ id, workload }`). Pass it as `scenario({ tenants })`.',
  guidance: `
- Streams are independent and reproducible: the same seed and count give the same tenants.
- All tenants must share one period and step (\`evaluate\` throws otherwise). Pools use the first tenant's \`peak\` setting, and its params for any \`param(…)\` in pool capacities or pod requests.
- Use it for heterogeneous populations (random sizes, feature mixes); use \`zipfTenants\` when sizes follow a rank distribution.`,
  examples: [
    `import { bill, dimension, q, request, series, service, simulateTenants, u, workload } from 'pricesim'

const ops = dimension('api.ops', u.op, 1e-6)
const api = service('api', {
  requests: () => ({ call: request({}, () => ({ bill: [bill(ops, q(1, u.op))] })) }),
})

// 50 tenants with rates uniform between 1 and 100 req/s
const tenants = simulateTenants({
  count: 50,
  seed: 42,
  make: ({ rng }) =>
    workload(api, {
      requests: { call: { rate: series.constant(q(1 + 99 * rng.next(), u.req.div(u.s))), attrs: {} } },
    }),
})`,
  ],
  seeAlso: ['zipfTenants', 'scenario', 'rng'],
  guide: 'workloads',
})

doc({
  name: 'zipfTenants',
  kind: 'function',
  module: 'pricesim',
  summary: 'Generate `count` tenants whose sizes follow a Zipf distribution: a few large tenants and a long tail.',
  signature:
    'zipfTenants(opts: { count: number; exponent?: number; seed?: number; idPrefix?: string; make: (t: TenantDraw & { share: number }) => Workload }): Tenant[]',
  params: [
    { name: 'opts.count', type: 'number', doc: 'Number of tenants.' },
    {
      name: 'opts.exponent',
      type: 'number',
      optional: true,
      default: '1',
      doc: 'Zipf exponent: rank r gets weight ∝ 1/r^exponent. Larger is more skewed.',
    },
    { name: 'opts.seed', type: 'number', optional: true, default: '1', doc: 'Root seed for the per-tenant streams.' },
    {
      name: 'opts.idPrefix',
      type: 'string',
      optional: true,
      default: "'tenant-'",
      doc: 'Id prefix, as in `simulateTenants`.',
    },
    {
      name: 'opts.make',
      type: '(t: { id; index; rng; share }) => Workload',
      doc: "Builds one tenant's workload. `share` is its fraction of the total (shares sum to 1); `index` 0 is the largest tenant.",
    },
  ],
  returns: '`Tenant[]`, largest first. Pass it as `scenario({ tenants })`.',
  guidance: `
- Scale the total by \`share\` yourself, e.g. \`q(TOTAL * share, perSecond)\`. Shares are fixed by rank; \`rng\` is there for per-tenant variation on top (feature mix, payload size).
- Useful for the market view: how much of the cost the top tenants drive, and how much sharing one deployment saves over dedicated ones (compare with \`withWorkload(shared, t.workload, t.id)\` per tenant).
- Many tenants × distribution-valued attributes × \`samples\` multiplies evaluation work; lower \`samples\` in large tenant runs.`,
  examples: [
    `import { bill, dimension, evaluate, pricing, q, request, scenario, series, service, u, workload, zipfTenants } from 'pricesim'

const ops = dimension('api.ops', u.op, 1e-6)
const api = service('api', {
  requests: () => ({ call: request({}, () => ({ bill: [bill(ops, q(1, u.op))] })) }),
})

// 200 tenants sharing 2,000 req/s
const tenants = zipfTenants({
  count: 200,
  seed: 7,
  make: ({ share }) =>
    workload(api, {
      requests: { call: { rate: series.diurnal({ mean: q(2000 * share, u.req.div(u.s)), peakToMean: 1.5 }), attrs: {} } },
    }),
})
const r = evaluate(scenario({ name: 'shared', root: api, tenants, pricing: pricing() }))
const top10 = r.tenants!.slice(0, 10)`,
  ],
  seeAlso: ['simulateTenants', 'zipfWeights', 'scenario', 'evaluate'],
  guide: 'workloads',
})
