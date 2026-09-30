// EC2 instance types: the generated current-generation catalog (ec2.gen.ts: AWS rates; ec2-specs.gen.ts:
// network/EBS/instance-store specs from ec2instances.info), exposed as capacity resources plus on-demand, RI
// and Savings Plan rates.
import { q } from '../../core/expr.ts'
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import type { InstanceType } from '../../model/capacity.ts'
import { dimension } from '../../pricing/dimension.ts'
import { ec2Specs, type Ec2Spec } from './ec2-specs.gen.ts'
import { ec2CommitmentTerms, ec2Prices, type Ec2InstanceId, type Ec2PriceRow } from './ec2.gen.ts'
import { SOURCES } from './sources.ts'

export type { Ec2InstanceId, Ec2Spec }
/** Raw instance specs (arch, network, EBS, instance store, EKS max pods) for every current-generation type. */
export { ec2Specs }

doc({
  name: 'ec2Specs',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary:
    'Raw specs per current-generation EC2 instance type: architecture, network, EBS, instance store, EKS max pods.',
  signature: 'ec2Specs: Record<string, Ec2Spec>',
  guidance: `
- Fields (each omitted when the source has no or a zero value): \`arch\`; \`network: [baseline, burst]\` Gbps of the primary network card; \`ebsMbps: [baseline, max]\`; \`ebsIops: [baseline, max]\` (16 KiB I/O); \`store: { disks, diskGB, nvme, ssd, readIops?, writeIops? }\` (IOPS summed over all volumes); \`maxPods\` (EKS VPC CNI default).
- From ec2instances.info (Vantage), retrieved 2026-09-24. \`ec2\` already turns these into capacity; read them directly for \`maxPods\` (e.g. a \`nodePool\`'s \`maxPods\`) or burst figures.`,
  examples: [
    `import { ec2Specs } from 'pricesim/aws'

const maxPods = ec2Specs['m7g.xlarge']?.maxPods // 58`,
  ],
  seeAlso: ['ec2', 'nodePool'],
  guide: 'catalog',
})

const opsPerSec = u.op.div(u.s)

/** Capacity vector of an instance type from its vCPU/memory and specs (EBS and NVMe only when known). */
export const instanceCapacity = (
  vcpu: number,
  memoryGiB: number,
  spec: Ec2Spec & { network: readonly [number, number] },
): InstanceType['capacity'] => {
  const store = spec.store?.nvme && spec.store.ssd ? spec.store : undefined
  return {
    cpu: q(vcpu, u.vCPU),
    memory: q(memoryGiB, u.GiB),
    network: q(spec.network[0], u.Gbps),
    ...(spec.ebsMbps ? { ebsBandwidth: q(spec.ebsMbps[0], u.Mbps) } : {}),
    ...(spec.ebsIops ? { ebsIops: q(spec.ebsIops[0], opsPerSec) } : {}),
    ...(store
      ? {
          nvme: {
            bytes: q(store.disks * store.diskGB, u.GB),
            ...(store.readIops !== undefined ? { readIops: q(store.readIops, opsPerSec) } : {}),
            ...(store.writeIops !== undefined ? { writeIops: q(store.writeIops, opsPerSec) } : {}),
          },
        }
      : {}),
  }
}

doc({
  name: 'instanceCapacity',
  kind: 'function',
  module: 'pricesim/aws',
  summary: "Build an `InstanceType['capacity']` from vCPU, memory and an `Ec2Spec` that has a network figure.",
  signature: "instanceCapacity(vcpu: number, memoryGiB: number, spec: Ec2Spec & { network }): InstanceType['capacity']",
  returns:
    '`cpu` (vCPU), `memory` (GiB), `network` (baseline Gbps), plus `ebsBandwidth` (baseline Mbps) and `ebsIops` (baseline) when the spec has them, and `nvme` (total bytes, read/write IOPS) only for NVMe SSD instance stores.',
  guidance:
    '- Used by `ec2` and the Aurora instance classes. Call it to build a custom `InstanceType` (e.g. another price) with real EC2 capacity.',
  seeAlso: ['ec2', 'specWithNetwork'],
  guide: 'catalog',
})

/** Specs for an instance type that has a baseline network figure. */
export const specWithNetwork = (id: string): (Ec2Spec & { network: readonly [number, number] }) | undefined => {
  const s = ec2Specs[id]
  return s?.network ? (s as Ec2Spec & { network: readonly [number, number] }) : undefined
}

doc({
  name: 'specWithNetwork',
  kind: 'function',
  module: 'pricesim/aws',
  summary:
    '`ec2Specs[id]` if that type has a baseline network figure, else undefined; the input `instanceCapacity` needs.',
  signature: 'specWithNetwork(id: string): (Ec2Spec & { network }) | undefined',
  seeAlso: ['instanceCapacity', 'ec2Specs'],
  guide: 'catalog',
})

const ec2Instance = (id: Ec2InstanceId, row: Ec2PriceRow): InstanceType => {
  const spec = specWithNetwork(id)
  if (!spec) throw new Error(`ec2: no baseline network for ${id}`) // the generator only emits types that have one
  return {
    id,
    capacity: instanceCapacity(row.vcpu, row.memoryGiB, spec),
    price: dimension(`aws.ec2.${id}.hours`, u.hour, row.od, { family: 'aws.ec2.compute', source: SOURCES.ec2 }),
  }
}

/** Every current-generation instance type (Linux, shared tenancy, us-east-1 list prices), e.g. `ec2['m7g.2xlarge']`. */
export const ec2 = Object.fromEntries(
  (Object.entries(ec2Prices) as [Ec2InstanceId, Ec2PriceRow][]).map(([id, row]) => [id, ec2Instance(id, row)]),
) as Readonly<Record<Ec2InstanceId, InstanceType>>

doc({
  name: 'ec2',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary:
    'Every current-generation EC2 instance type as an `InstanceType` (capacity + on-demand hourly price), keyed by type id.',
  signature: 'ec2: Record<Ec2InstanceId, InstanceType>',
  returns:
    "Look up a type by id: `ec2['m7g.xlarge']` (ids are type-checked). Pass it as `instance` to `instancePool` or `nodePool`.",
  guidance: `
- **Coverage:** 1,328 types (as of the last \`pnpm gen:aws\`), Linux, shared tenancy, us-east-1 list prices retrieved 2026-09-24. Types without a baseline network figure are left out.
- **\`capacity\`:** \`cpu\` (vCPU), \`memory\` (GiB), \`network\` (baseline Gbps of the primary card, not the "up to" burst), \`ebsBandwidth\` (baseline Mbps) and \`ebsIops\` (baseline, 16 KiB I/O) when known, \`nvme\` (\`bytes\`, \`readIops?\`, \`writeIops?\`, summed over disks) only for NVMe SSD instance stores. Pools size on these; nothing else (e.g. burst, EKS max pods) is in \`capacity\`.
- **\`price\`:** dimension \`aws.ec2.<id>.hours\`, USD per instance-hour on demand, family \`aws.ec2.compute\`.
- **RIs and Savings Plans:** the catalog bills on-demand. Apply a commitment as a family discount, \`pricing({ familyDiscounts: { 'aws.ec2': d } })\`, with \`d = ec2CommitmentDiscount(id, option)\`. A family discount matches by prefix, so \`'aws.ec2'\` discounts *every* EC2 instance-hour in the scenario (all types, used and idle) by the same fraction, as if fully covered. EBS (\`aws.ebs\`) and Aurora (\`aws.rds\`) are not in that family.
- Raw commitment rates are in \`ec2Rates\`; raw specs (including \`maxPods\`) in \`ec2Specs\`.`,
  examples: [
    `import { instancePool } from 'pricesim/model'
import { ec2 } from 'pricesim/aws'

// m7g.xlarge: 4 vCPU, 16 GiB, 1.876 Gbps baseline network, 1,250 Mbps / 6,000 IOPS EBS baseline, $0.1632/hour
const web = instancePool('web', { instance: ec2['m7g.xlarge'], min: 2, loadFactor: 0.7, azs: 2 })`,
    `import { pricing } from 'pricesim'
import { ec2CommitmentDiscount } from 'pricesim/aws'

// 1-year no-upfront Compute Savings Plan on m7g.xlarge: $0.1199 vs $0.1632/hour, about 26.5% off
const sp = ec2CommitmentDiscount('m7g.xlarge', 'computeSavingsPlan1yNoUpfront') ?? 0
export const committed = pricing({ familyDiscounts: { 'aws.ec2': sp } })`,
  ],
  seeAlso: ['ec2Rates', 'ec2CommitmentDiscount', 'ec2Specs', 'instancePool', 'nodePool', 'pricing'],
  guide: 'catalog',
})

type Cap<S extends string> = S extends `${infer H}${infer T}` ? `${Uppercase<H>}${T}` : S
type Option = (typeof ec2CommitmentTerms)[number]
/** e.g. 'reserved1yNoUpfront', 'computeSavingsPlan3yAllUpfront' */
export type Ec2CommitmentOption =
  `reserved${Option[0]}${Cap<Option[1]>}` | `computeSavingsPlan${Option[0]}${Cap<Option[1]>}`

/**
 * USD per instance-hour. Reserved rates are standard RIs, Savings Plan rates are Compute Savings Plans; both
 * are effective hourly rates with any upfront fee amortized over the term. Absent when AWS does not offer it.
 */
export type Ec2Rates = { readonly onDemand: number } & { readonly [K in Ec2CommitmentOption]?: number }

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1)
const ratesOf = (row: Ec2PriceRow): Ec2Rates => {
  const out: Record<string, number> = { onDemand: row.od }
  ec2CommitmentTerms.forEach(([term, pay], i) => {
    const ri = row.ri?.[i]
    const sp = row.sp?.[i]
    if (ri != null) out[`reserved${term}${cap(pay)}`] = ri
    if (sp != null) out[`computeSavingsPlan${term}${cap(pay)}`] = sp
  })
  return out as Ec2Rates
}

/** On-demand and commitment rates per instance type, e.g. `ec2Rates['m7g.2xlarge'].reserved1yNoUpfront`. */
export const ec2Rates = Object.fromEntries(
  (Object.entries(ec2Prices) as [Ec2InstanceId, Ec2PriceRow][]).map(([id, row]) => [id, ratesOf(row)]),
) as Readonly<Record<Ec2InstanceId, Ec2Rates>>

doc({
  name: 'ec2Rates',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'On-demand and commitment rates per EC2 instance type, in USD per instance-hour.',
  signature: 'ec2Rates: Record<Ec2InstanceId, { onDemand: number; [option: Ec2CommitmentOption]?: number }>',
  guidance: `
- Keys: \`onDemand\`, and where AWS offers them \`reserved<1y|3y><NoUpfront|PartialUpfront|AllUpfront>\` (standard RIs) and \`computeSavingsPlan<1y|3y><…>\` (Compute Savings Plans), e.g. \`reserved1yNoUpfront\`, \`computeSavingsPlan3yAllUpfront\`.
- Commitment rates are effective hourly rates with any upfront fee amortized over the term. A missing key means the option isn't offered for that type.
- us-east-1, Linux, shared tenancy, retrieved 2026-09-24. The engine doesn't read these; use \`ec2CommitmentDiscount\` to turn one into a \`familyDiscounts\` fraction.`,
  examples: [
    `import { ec2Rates } from 'pricesim/aws'

const r = ec2Rates['m7g.xlarge']
const ri = r.reserved1yNoUpfront // 0.108 vs onDemand 0.1632`,
  ],
  seeAlso: ['ec2', 'ec2CommitmentDiscount'],
  guide: 'catalog',
})

/**
 * Fractional discount of a commitment against on-demand for one instance type, e.g. to feed
 * `pricing({ familyDiscounts: { 'aws.ec2': ec2CommitmentDiscount('m7g.2xlarge', 'computeSavingsPlan1yNoUpfront') } })`.
 * Undefined when the commitment is not offered for that type.
 */
export const ec2CommitmentDiscount = (id: Ec2InstanceId, option: Ec2CommitmentOption): number | undefined => {
  const r = ec2Rates[id]
  const c = r[option]
  return c === undefined ? undefined : 1 - c / r.onDemand
}

doc({
  name: 'ec2CommitmentDiscount',
  kind: 'function',
  module: 'pricesim/aws',
  summary: "A commitment's fractional discount against on-demand for one EC2 instance type.",
  signature: 'ec2CommitmentDiscount(id: Ec2InstanceId, option: Ec2CommitmentOption): number | undefined',
  params: [
    { name: 'id', type: 'Ec2InstanceId', doc: "Instance type, e.g. `'m7g.2xlarge'`." },
    {
      name: 'option',
      type: 'Ec2CommitmentOption',
      doc: "`reserved` or `computeSavingsPlan`, then `1y`/`3y`, then `NoUpfront`/`PartialUpfront`/`AllUpfront`, e.g. `'reserved3yPartialUpfront'`.",
    },
  ],
  returns:
    '`1 − commitment rate / on-demand rate`, a fraction in 0–1, or undefined when the option is not offered for that type.',
  guidance: `
- Feed it to \`pricing({ familyDiscounts: { 'aws.ec2': … } })\`. That discount then applies to every EC2 instance-hour in the scenario, so with mixed instance types pick the dominant one or a weighted figure.
- Modeling a commitment as a discount assumes it covers all instance-hours; partial coverage and unused commitment are not modeled.`,
  examples: [
    `import { pricing } from 'pricesim'
import { ec2CommitmentDiscount } from 'pricesim/aws'

const d = ec2CommitmentDiscount('c7g.2xlarge', 'reserved1yNoUpfront')
export const ctx = pricing({ familyDiscounts: { 'aws.ec2': d ?? 0 } })`,
  ],
  seeAlso: ['ec2Rates', 'ec2', 'pricing'],
  guide: 'catalog',
})
