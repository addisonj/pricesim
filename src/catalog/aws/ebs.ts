// EBS volumes attached to pools: gp3 (General Purpose SSD). Use as `volumes: [{ type: gp3, size: q(100, u.GiB) }`
// on an instance pool or node pool; every instance (node) gets one volume.
//
// Billing (us-east-1): storage per GB-month, plus provisioned IOPS above the free 3,000 and provisioned
// throughput above the free 125 MiB/s. AWS sizes and bills volumes in GiB ("GB" on the price list), and
// prices throughput per GiB/s-month ($40.96, i.e. $0.04 per MiB/s-month).
//
// Simplifications:
//   - volumes are provisioned for the whole period (billing is per second, like the instances), and one
//     volume per instance/node; snapshots, fast snapshot restore and EBS direct APIs are not modeled
//   - a volume's IOPS and throughput add to the instance's EBS capacity, capped by the instance's EBS limits
//     (model/capacity.ts `nodeCapacity`); burst credits and per-volume latency are not modeled
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import type { VolumeType } from '../../model/capacity.ts'
import { dimension } from '../../pricing/dimension.ts'
import { SOURCES } from './sources.ts'

const opsPerSec = u.op.div(u.s)
const MiBps = u.MiB.div(u.s)
const GiB = 1024 ** 3
const MiB = 1024 ** 2

export const ebsRates = {
  /** "Storage General Purpose gp3 GB Mo" */
  gp3Storage: dimension('aws.ebs.gp3.storage', u.GiB.mul(u.month), 0.08, { family: 'aws.ebs', source: SOURCES.ebs }),
  /** "Provisioned EBS IOPS gp3 Volumes per IOPS Mo", above the free 3,000 */
  gp3Iops: dimension('aws.ebs.gp3.iops', opsPerSec.mul(u.month), 0.005, { family: 'aws.ebs', source: SOURCES.ebs }),
  /** "Provisioned Throughput gp3 per GiBps mo" $40.96 = $0.04 per MiB/s-month, above the free 125 MiB/s */
  gp3Throughput: dimension('aws.ebs.gp3.throughput', MiBps.mul(u.month), 40.96 / 1024, {
    family: 'aws.ebs',
    source: SOURCES.ebs,
  }),
}

doc({
  name: 'ebsRates',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'The gp3 billing dimensions: storage, provisioned IOPS and provisioned throughput.',
  signature: 'ebsRates: { gp3Storage; gp3Iops; gp3Throughput }',
  guidance: `
- \`gp3Storage\`: $0.08 per GiB-month.
- \`gp3Iops\`: $0.005 per IOPS-month above the free 3,000.
- \`gp3Throughput\`: $0.04 per MiB/s-month ($40.96 per GiB/s-month) above the free 125 MiB/s.
- Family \`aws.ebs\`, us-east-1, retrieved 2026-09-24. Billed through \`gp3\` volumes on pools; you rarely use these directly.`,
  seeAlso: ['gp3', 'gp3Limits'],
  guide: 'catalog',
})

/** gp3 limits (docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html) */
export const gp3Limits = {
  minSize: 1 * GiB,
  maxSize: 64 * 1024 * GiB,
  /** included with every volume */
  baseIops: 3000,
  maxIops: 80_000,
  /** max provisioned IOPS per GiB of size */
  iopsPerGiB: 500,
  /** included with every volume, byte/s */
  baseThroughput: 125 * MiB,
  maxThroughput: 2000 * MiB,
  /** max provisioned throughput per provisioned IOPS, byte/s */
  throughputPerIops: 0.25 * MiB,
} as const

doc({
  name: 'gp3Limits',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'gp3 volume limits, in base units (bytes, op/s, byte/s), that `gp3` validates against.',
  guidance: `
- Size 1 GiB – 64 TiB. IOPS: 3,000 included, up to 80,000 and at most 500 per GiB of size. Throughput: 125 MiB/s included, up to 2,000 MiB/s and at most 0.25 MiB/s per provisioned IOPS.
- Fields: \`minSize\`, \`maxSize\`, \`baseIops\`, \`maxIops\`, \`iopsPerGiB\`, \`baseThroughput\`, \`maxThroughput\`, \`throughputPerIops\`.`,
  seeAlso: ['gp3'],
  guide: 'catalog',
})

const fmt = (n: number) => String(Number(n.toPrecision(6)))

/** General Purpose SSD (gp3). IOPS default to 3,000 and throughput to 125 MiB/s (both free). */
export const gp3: VolumeType = {
  id: 'gp3',
  provision: ({ size, iops, throughput }) => {
    const L = gp3Limits
    const io = iops ?? L.baseIops
    const tp = throughput ?? L.baseThroughput
    const fail = (msg: string) => {
      throw new Error(`gp3 volume: ${msg}`)
    }
    if (size < L.minSize || size > L.maxSize) fail(`size ${fmt(size / GiB)} GiB is outside 1 GiB – 64 TiB`)
    const maxIops = Math.min(L.maxIops, Math.max(L.baseIops, L.iopsPerGiB * (size / GiB)))
    if (io < L.baseIops || io > maxIops) fail(`${fmt(io)} IOPS is outside 3,000 – ${fmt(maxIops)} for this size`)
    const maxTp = Math.min(L.maxThroughput, L.throughputPerIops * io)
    if (tp < L.baseThroughput || tp > maxTp) {
      fail(`${fmt(tp / MiB)} MiB/s is outside 125 – ${fmt(maxTp / MiB)} MiB/s for ${fmt(io)} IOPS`)
    }
    return {
      iops: io,
      throughput: tp,
      usage: [
        // base units per volume-second: byte·s per s = bytes; op/s·s per s = op/s; byte/s·s per s = byte/s
        { dimension: ebsRates.gp3Storage, perSecond: size },
        { dimension: ebsRates.gp3Iops, perSecond: io - L.baseIops },
        { dimension: ebsRates.gp3Throughput, perSecond: tp - L.baseThroughput },
      ],
    }
  },
}

doc({
  name: 'gp3',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'The EBS General Purpose SSD (gp3) volume type, for `volumes` on instance and node pools.',
  signature: 'gp3: VolumeType',
  guidance: `
- Use as \`volumes: [{ type: gp3, size, iops?, throughput?, count? }]\` on \`instancePool\` or \`nodePool\`. Every instance (node) gets \`count\` volumes (default 1) of that spec, billed for the whole period, idle instances included.
- **Billing** (\`ebsRates\`, retrieved 2026-09-24): $0.08/GiB-month of size, $0.005/IOPS-month above 3,000, $0.04 per MiB/s-month above 125 MiB/s. IOPS default to 3,000 and throughput to 125 MiB/s, both free.
- **Capacity:** each volume adds its size as \`disk\`, and its IOPS and throughput to the instance's EBS IOPS and bandwidth, capped by the instance's own EBS baseline when the type has one.
- **Validation:** throws outside the \`gp3Limits\` (size 1 GiB – 64 TiB; IOPS 3,000 to min(80,000, 500/GiB); throughput 125 MiB/s to min(2,000 MiB/s, 0.25 MiB/s per IOPS)).
- Not modeled: snapshots, burst credits, per-volume latency, growing volumes (when disk binds, the pool adds instances).`,
  examples: [
    `import { q, u } from 'pricesim'
import { instancePool } from 'pricesim/model'
import { ec2, gp3 } from 'pricesim/aws'

export const db = instancePool('db', {
  instance: ec2['r7g.xlarge'],
  min: 3,
  loadFactor: 0.7,
  azs: 3,
  volumes: [{ type: gp3, size: q(2, u.TiB), iops: q(12_000, u.op.div(u.s)), throughput: q(500, u.MiB.div(u.s)) }],
})`,
  ],
  seeAlso: ['ebsRates', 'gp3Limits', 'instancePool', 'nodePool'],
  guide: 'catalog',
})
