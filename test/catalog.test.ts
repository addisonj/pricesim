// The generated AWS catalog (scripts/fetch-aws-prices.ts): verified us-east-1 list prices and specs, plus
// sanity checks over the whole generated EC2 catalog.
import { describe, expect, it } from 'vitest'
import { u } from '../src/core/units.ts'
import {
  auroraInstances,
  auroraMysqlInstances,
  auroraStandard,
  dynamodbOnDemand,
  ec2,
  ec2CommitmentDiscount,
  ec2Rates,
  ec2Specs,
  s3Standard,
} from '../src/catalog/aws/index.ts'
import type { InstanceType } from '../src/model/capacity.ts'
import type { PriceSchedule } from '../src/pricing/dimension.ts'

const rate = (s: PriceSchedule): number => {
  if (s.kind !== 'flat') throw new Error(`expected a flat rate, got ${s.kind}`)
  return s.rate
}
const gbps = (i: InstanceType) => i.capacity.network.eval() / u.Gbps.scale
const vcpu = (i: InstanceType) => i.capacity.cpu.eval() / u.vCPU.scale
const gib = (i: InstanceType) => i.capacity.memory.eval() / u.GiB.scale

describe('EC2', () => {
  it.each([
    ['m7g.xlarge', 0.1632, 4, 16, 1.876],
    ['m7g.2xlarge', 0.3264, 8, 32, 3.75],
    ['m7g.4xlarge', 0.6528, 16, 64, 7.5],
    ['c7g.xlarge', 0.145, 4, 8, 1.876],
    ['c7g.2xlarge', 0.29, 8, 16, 3.75],
  ] as const)('%s: $%f/h, %i vCPU, %i GiB, %f Gbps baseline', (id, usd, cpus, mem, net) => {
    const i = ec2[id]
    expect(i.id).toBe(id)
    expect(rate(i.price.schedule)).toBe(usd)
    expect(i.price.family).toBe('aws.ec2.compute')
    expect(vcpu(i)).toBe(cpus)
    expect(gib(i)).toBe(mem)
    expect(gbps(i)).toBeCloseTo(net, 9)
    expect(ec2Rates[id].onDemand).toBe(usd)
  })

  it('has EBS baselines and local NVMe where the type has them', () => {
    const m = ec2['m7g.2xlarge'].capacity
    expect(m.ebsBandwidth!.eval()).toBeCloseTo(2500 * u.Mbps.scale, 3) // 2,500 Mbps baseline
    expect(m.ebsIops!.eval()).toBe(12000)
    expect(m.nvme).toBeUndefined()
    const d = ec2['m7gd.xlarge'].capacity.nvme!
    expect(d.bytes.eval()).toBe(237e9)
    expect(d.readIops!.eval()).toBeGreaterThan(0)
  })

  it('exposes RI and Savings Plan rates below on-demand', () => {
    const r = ec2Rates['m7g.2xlarge']
    expect(r.reserved1yNoUpfront).toBe(0.2159)
    expect(r.computeSavingsPlan1yNoUpfront).toBe(0.2398)
    for (const v of [r.reserved1yNoUpfront, r.reserved3yAllUpfront, r.computeSavingsPlan1yNoUpfront]) {
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThan(r.onDemand)
    }
    // deeper commitments are cheaper
    expect(r.reserved3yAllUpfront!).toBeLessThan(r.reserved1yNoUpfront!)
    expect(r.computeSavingsPlan3yAllUpfront!).toBeLessThan(r.computeSavingsPlan1yNoUpfront!)
    expect(ec2CommitmentDiscount('m7g.2xlarge', 'reserved1yNoUpfront')).toBeCloseTo(1 - 0.2159 / 0.3264, 12)
  })

  it('is a full current-generation catalog with positive prices and specs', () => {
    const all = Object.values(ec2)
    expect(all.length).toBeGreaterThan(800)
    const families = new Set(all.map((i) => i.id.split('.')[0]))
    for (const f of ['m7g', 'c7g', 'r7g', 'm7i', 'c7i', 'r7i', 'm8g', 'i4i', 't4g']) expect(families).toContain(f)
    for (const i of all) {
      expect(rate(i.price.schedule), i.id).toBeGreaterThan(0)
      expect(vcpu(i), i.id).toBeGreaterThan(0)
      expect(gib(i), i.id).toBeGreaterThan(0)
      expect(gbps(i), i.id).toBeGreaterThan(0)
      if (i.capacity.ebsBandwidth) expect(i.capacity.ebsBandwidth.eval(), i.id).toBeGreaterThan(0)
      if (i.capacity.ebsIops) expect(i.capacity.ebsIops.eval(), i.id).toBeGreaterThan(0)
      if (i.capacity.nvme) expect(i.capacity.nvme.bytes.eval(), i.id).toBeGreaterThan(0)
      const r = ec2Rates[i.id as keyof typeof ec2Rates]
      for (const [k, v] of Object.entries(r)) if (k !== 'onDemand') expect(v, `${i.id} ${k}`).toBeLessThan(r.onDemand)
    }
    // most types have EBS figures; the specs cover every catalog type
    expect(all.filter((i) => i.capacity.ebsBandwidth).length).toBeGreaterThan(all.length * 0.9)
    for (const i of all) expect(ec2Specs[i.id], i.id).toBeDefined()
  })
})

describe('S3 Standard', () => {
  it('storage tiers and request rates', () => {
    const s = s3Standard.storage.schedule
    expect(s.kind).toBe('tiered')
    if (s.kind !== 'tiered') return
    expect(s.tiers).toEqual([
      { upTo: 50_000, rate: 0.023 },
      { upTo: 500_000, rate: 0.022 },
      { upTo: null, rate: 0.021 },
    ])
    expect(rate(s3Standard.putRequests.schedule)).toBe(0.000005)
    expect(rate(s3Standard.getRequests.schedule)).toBe(0.0000004)
  })
})

describe('DynamoDB on-demand', () => {
  it('request units and storage with a 25 GB free tier', () => {
    expect(rate(dynamodbOnDemand.writeUnits.schedule)).toBe(0.000000625)
    expect(rate(dynamodbOnDemand.readUnits.schedule)).toBe(0.000000125)
    expect(dynamodbOnDemand.storage.schedule).toEqual({
      kind: 'freeTier',
      free: 25,
      then: { kind: 'flat', rate: 0.25 },
    })
  })
})

describe('Aurora', () => {
  it.each([
    ['db.r7g.large', 0.276, 2, 16, 0.937],
    ['db.r7g.xlarge', 0.553, 4, 32, 1.876],
  ] as const)('PostgreSQL %s: $%f/h, %i vCPU, %i GiB, %f Gbps', (id, usd, cpus, mem, net) => {
    const i = auroraInstances[id]
    expect(rate(i.price.schedule)).toBe(usd)
    expect(i.price.family).toBe('aws.rds')
    expect(vcpu(i)).toBe(cpus)
    expect(gib(i)).toBe(mem)
    expect(gbps(i)).toBeCloseTo(net, 9)
  })

  it('storage, I/O and MySQL instance classes', () => {
    expect(rate(auroraStandard.storage.schedule)).toBe(0.1)
    expect(rate(auroraStandard.io.schedule)).toBe(0.0000002)
    expect(rate(auroraMysqlInstances['db.r7g.large'].price.schedule)).toBe(0.276)
    expect(Object.keys(auroraInstances).length).toBeGreaterThan(40)
  })
})
