// Aurora PostgreSQL (Aurora Standard): provisioned instances (writer + readers) sized by CPU, storage per
// GB-month, and I/O per request. Rates from aurora.gen.ts (RDS bulk price list); instance capacity from the
// matching EC2 instance type's docs specs (db.r7g.large → r7g.large).
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import { instancePool, type InstanceType } from '../../model/capacity.ts'
import { offering } from '../../model/node.ts'
import { bill, gauge, request } from '../../model/request.ts'
import { dimension } from '../../pricing/dimension.ts'
import { auroraPrices, auroraStorageRates, type AuroraPriceRow } from './aurora.gen.ts'
import { instanceCapacity, specWithNetwork } from './ec2.ts'
import { SOURCES } from './sources.ts'

type Engine = keyof typeof auroraPrices

const dbInstances = <E extends Engine>(engine: E) => {
  const out: Record<string, InstanceType> = {}
  for (const [id, row] of Object.entries(auroraPrices[engine]) as [string, AuroraPriceRow][]) {
    // instance classes without an EC2 counterpart in the docs (e.g. db.r4, db.t3) have no baseline network
    const spec = specWithNetwork(id.replace(/^db\./, ''))
    if (!spec) continue
    out[id] = {
      id,
      capacity: instanceCapacity(row.vcpu, row.memoryGiB, spec),
      price: dimension(`aws.aurora-${engine}.${id}.hours`, u.hour, row.od, { family: 'aws.rds', source: SOURCES.rds }),
    }
  }
  return out as Readonly<Record<keyof (typeof auroraPrices)[E], InstanceType>>
}

/** Aurora PostgreSQL instance classes (Aurora Standard, Single-AZ instance-hours), e.g. `auroraInstances['db.r7g.large']`. */
export const auroraInstances = dbInstances('postgresql')

doc({
  name: 'auroraInstances',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: "Aurora PostgreSQL instance classes as `InstanceType`s, e.g. `auroraInstances['db.r7g.large']`.",
  signature: 'auroraInstances: Record<AuroraClass, InstanceType>',
  guidance: `
- \`price\`: Aurora Standard on-demand USD per instance-hour, dimension \`aws.aurora-postgresql.<class>.hours\`, family \`aws.rds\` (so an \`'aws.ec2'\` discount doesn't touch it). From the RDS price list retrieved 2026-09-24.
- \`capacity\`: that of the matching EC2 type (\`db.r7g.large\` → \`r7g.large\`), as in \`ec2\`; classes without such a type are left out.
- Pass one to \`auroraPostgres\`, or to \`instancePool\` for your own model.`,
  seeAlso: ['auroraPostgres', 'auroraMysqlInstances', 'auroraPrices'],
  guide: 'catalog',
})
/** Aurora MySQL instance classes (Aurora Standard). */
export const auroraMysqlInstances = dbInstances('mysql')

doc({
  name: 'auroraMysqlInstances',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'Aurora MySQL instance classes as `InstanceType`s (Aurora Standard on-demand rates, family `aws.rds`).',
  guidance:
    '- Same shape as `auroraInstances`. There is no MySQL cluster offering: use these with `instancePool` and bill storage and I/O with `auroraStandard` (whose rates are the PostgreSQL ones; the price list has the same MySQL rates).',
  seeAlso: ['auroraInstances', 'auroraStandard'],
  guide: 'catalog',
})
/** Raw generated rates per engine and instance class: on-demand, I/O-Optimized and reserved (see aurora.gen.ts). */
export { auroraPrices }

doc({
  name: 'auroraPrices',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary:
    'Raw Aurora instance rates per engine (`postgresql`, `mysql`) and class: on-demand, I/O-Optimized, reserved.',
  guidance: `
- Row: \`{ vcpu, memoryGiB, od, ioOptimized, ri }\`. \`od\` and \`ioOptimized\` are USD per instance-hour (Aurora Standard / I/O-Optimized); \`ioOptimized\` is null when not offered.
- \`ri\`: standard reserved-instance effective hourly rates (upfront amortized) in the order 1y no/partial/all upfront, then 3y no/partial/all upfront; an entry is null when not offered, and \`ri\` is null when none is.
- The engine doesn't read these; use them to derive a \`familyDiscounts: { 'aws.rds': … }\` fraction, e.g. \`1 - ri[0] / od\`.`,
  seeAlso: ['auroraInstances'],
  guide: 'catalog',
})

export const auroraStandard = {
  storage: dimension('aws.aurora.storage', u.GB.mul(u.month), auroraStorageRates.postgresql.storage, {
    family: 'aws.rds',
    source: SOURCES.aurora,
  }),
  io: dimension('aws.aurora.io', u.op, auroraStorageRates.postgresql.io, { family: 'aws.rds', source: SOURCES.aurora }),
}

doc({
  name: 'auroraStandard',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'Aurora Standard storage and I/O billing dimensions.',
  signature: 'auroraStandard: { storage; io }',
  guidance:
    '- `storage` $0.10/GB-month, `io` $0.20 per million I/O requests. Family `aws.rds`, us-east-1, retrieved 2026-09-24. I/O-Optimized storage is not modeled as a dimension.',
  seeAlso: ['auroraPostgres'],
  guide: 'catalog',
})

const coreMs = u.vCPU.mul(u.ms)

/**
 * An Aurora PostgreSQL cluster. `query` models a statement by the storage I/Os it causes (page reads that
 * miss the buffer cache plus page writes) and the CPU it burns on the instances.
 */
export const auroraPostgres = (
  name: string,
  opts: { instance: InstanceType; instances: number; loadFactor?: number; azs?: number },
) => {
  const instances = instancePool(`aurora:${name}`, {
    instance: opts.instance,
    min: opts.instances,
    loadFactor: opts.loadFactor ?? 0.6,
    azs: opts.azs ?? 2,
  })
  return offering(`aurora-postgresql:${name}`, {
    pools: { instances },
    gauges: { stored: gauge(u.byte, { billAs: auroraStandard.storage }) },
    requests: ({ pools }) => ({
      query: request({ ioReads: u.op, ioWrites: u.op, cpu: coreMs }, (r) => ({
        use: [pools.instances.cpu(r.cpu)],
        bill: [bill(auroraStandard.io, r.ioReads.add(r.ioWrites))],
      })),
    }),
  })
}

doc({
  name: 'auroraPostgres',
  kind: 'function',
  module: 'pricesim/aws',
  summary:
    'An Aurora PostgreSQL (Aurora Standard) cluster offering: an instance pool, queries by I/O and CPU, stored bytes.',
  signature:
    'auroraPostgres(name: string, opts: { instance: InstanceType; instances: number; loadFactor?: number; azs?: number }): Offering',
  params: [
    { name: 'name', type: 'string', doc: 'Node `aurora-postgresql:<name>`; its pool is `aurora:<name>`.' },
    { name: 'opts.instance', type: 'InstanceType', doc: "Instance class, e.g. `auroraInstances['db.r7g.large']`." },
    { name: 'opts.instances', type: 'number', doc: "The pool's minimum instance count (writer + readers)." },
    { name: 'opts.loadFactor', type: 'number', optional: true, default: '0.6', doc: 'Target CPU utilization at peak.' },
    { name: 'opts.azs', type: 'number', optional: true, default: '2', doc: "The pool's `azs` (descriptive)." },
  ],
  returns: "An offering; add it to a service's `deps`.",
  guidance: `
- **Request:** \`query({ ioReads, ioWrites, cpu })\`: \`ioReads + ioWrites\` (op) bill Aurora I/O at $0.20 per million; \`cpu\` (e.g. \`q(2, u.vCPU.mul(u.ms))\`) is demand on the instance pool.
- **Gauge:** \`stored\` (bytes), $0.10/GB-month.
- The pool sizes on CPU only (the only resource \`query\` uses) and never below \`instances\`. Memory, connections and replica lag are not modeled.
- I/O reads are page reads that miss the buffer cache; you estimate them.`,
  examples: [
    `import { q, u } from 'pricesim'
import { gauge, request, service } from 'pricesim/model'
import { auroraInstances, auroraPostgres } from 'pricesim/aws'

const db = auroraPostgres('orders', { instance: auroraInstances['db.r7g.large'], instances: 2 })
const coreMs = u.vCPU.mul(u.ms)
export const orders = service('orders', {
  deps: { db },
  gauges: { orders: gauge(u.count) },
  requests: ({ deps }) => ({
    place: request({}, () => ({
      calls: [deps.db.query({ ioReads: q(2, u.op), ioWrites: q(6, u.op), cpu: q(1.5, coreMs) })],
    })),
  }),
  gaugeMap: (g, { deps }) => [deps.db.gauges.stored(g.orders.mul(q(2, u.KB.div(u.count))))],
})`,
  ],
  seeAlso: ['auroraInstances', 'auroraStandard', 'instancePool'],
  guide: 'catalog',
})
