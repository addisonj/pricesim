// Data transfer between regions and over public IPs within a region, from us-east-1.
//
// Inter-region: data sent from us-east-1 to another AWS region is billed per GB by the sender
// (`USE1-<dest>-AWS-Out-Bytes`); the receiving side (`-AWS-In-Bytes`) is free. The rate depends on the
// destination: $0.02/GB to most regions, $0.01/GB to us-east-2, more to a few newer regions. There are no
// volume tiers.
//
// Same region over public IPs: traffic between resources in us-east-1 that goes through public IPv4 or
// Elastic IP addresses (or IPv6 addresses in another VPC) is billed as `DataTransfer-Regional-Bytes`, the
// same usage type and rate as cross-AZ transfer, and each side is charged: the sender for bytes out and the
// receiver for bytes in. Unlike private-IP traffic it is charged even within one AZ. The price list has a
// 1 GB/month free tier on regional transfer, aggregated across the account; it is not modeled.
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import { offering } from '../../model/node.ts'
import { bill, request } from '../../model/request.ts'
import { dimension, type BillingDimension } from '../../pricing/dimension.ts'
import { SOURCES } from './sources.ts'

type PerGB = BillingDimension<{ byte: 1 }>

const transfer = (id: string, rate: number, source = SOURCES.interRegion): PerGB =>
  dimension(`aws.transfer.${id}`, u.GB, rate, { family: 'aws.transfer', source })

const COMMON_RATE = 0.02

/** Data transfer out from us-east-1 to another AWS region at the common rate ($/GB). */
export const interRegion = transfer('inter-region', COMMON_RATE)

doc({
  name: 'interRegion',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'Data transfer out from us-east-1 to another AWS region at the common rate, $0.02/GB.',
  signature: 'interRegion: BillingDimension<byte>',
  guidance:
    '- Dimension `aws.transfer.inter-region`, family `aws.transfer`, no volume tiers, retrieved 2026-09-24. Billed to the sender; transfer in is free. Destinations with other rates get their own dimension from `interRegionTo`.',
  seeAlso: ['interRegionTransfer', 'interRegionTo', 'interRegionRates'],
  guide: 'catalog',
})

/**
 * Per-GB rates from us-east-1 to destinations that differ from the common `interRegion` rate, plus a few
 * common ones at that rate, by region code. Destinations not listed bill at `interRegion`.
 */
export const interRegionRates: Readonly<Record<string, number>> = {
  'us-east-2': 0.01,
  'us-west-1': 0.02,
  'us-west-2': 0.02,
  'ca-central-1': 0.02,
  'eu-west-1': 0.02,
  'eu-central-1': 0.02,
  'ap-northeast-1': 0.02,
  'ap-southeast-1': 0.02,
  'eusc-de-east-1': 0.05,
  'ap-southeast-7': 0.08,
}

doc({
  name: 'interRegionRates',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary:
    'Per-GB rates from us-east-1 by destination region code, for destinations that differ from $0.02 plus a few common ones.',
  guidance:
    "- Listed: us-east-2 $0.01; us-west-1, us-west-2, ca-central-1, eu-west-1, eu-central-1, ap-northeast-1, ap-southeast-1 $0.02; eusc-de-east-1 $0.05; ap-southeast-7 $0.08. Unlisted destinations bill at `interRegion`'s $0.02.",
  seeAlso: ['interRegionTo'],
  guide: 'catalog',
})

const byDestination = new Map<string, PerGB>()

/**
 * The inter-region transfer dimension for a destination region. Destinations billed at the common rate
 * share the `interRegion` dimension; the others get their own (`aws.transfer.inter-region.<region>`).
 */
export const interRegionTo = (region?: string): PerGB => {
  const rate = region === undefined ? undefined : interRegionRates[region]
  if (rate === undefined || rate === COMMON_RATE) return interRegion
  let d = byDestination.get(region!)
  if (!d) byDestination.set(region!, (d = transfer(`inter-region.${region}`, rate)))
  return d
}

doc({
  name: 'interRegionTo',
  kind: 'function',
  module: 'pricesim/aws',
  summary: 'The inter-region transfer dimension for a destination region (from us-east-1).',
  signature: 'interRegionTo(region?: string): BillingDimension<byte>',
  returns:
    '`interRegion` for undefined, unlisted or $0.02 destinations; otherwise a dimension `aws.transfer.inter-region.<region>` at that rate (the same object on every call).',
  seeAlso: ['interRegionTransfer', 'interRegionRates'],
  guide: 'catalog',
})

/** Data sent from us-east-1 to another region (`to`, a region code; default: the common rate). */
export const interRegionTransfer = (name = 'inter-region', opts: { to?: string } = {}) => {
  const dim = interRegionTo(opts.to)
  return offering(`inter-region:${name}`, {
    requests: () => ({
      /** `bytes` sent to the other region; transfer in to us-east-1 is free and not modeled */
      send: request({ bytes: u.byte }, (r) => ({ bill: [bill(dim, r.bytes)] })),
    }),
  })
}

doc({
  name: 'interRegionTransfer',
  kind: 'function',
  module: 'pricesim/aws',
  summary: 'Data sent from us-east-1 to another AWS region, billed per GB by destination.',
  signature: 'interRegionTransfer(name?: string, opts?: { to?: string }): Offering',
  params: [
    {
      name: 'name',
      type: 'string',
      optional: true,
      default: "'inter-region'",
      doc: 'Node name is `inter-region:<name>`.',
    },
    {
      name: 'opts.to',
      type: 'string',
      optional: true,
      doc: "Destination region code, e.g. `'us-east-2'` ($0.01/GB). Default and unlisted regions: $0.02/GB.",
    },
  ],
  returns: "An offering; add it to a service's `deps`.",
  guidance: `
- **Request:** \`send({ bytes })\`: bytes sent to the other region, billed to the sender. No volume tiers.
- Transfer in to us-east-1 is free and not modeled, and the other region's own costs are not included.`,
  examples: [
    `import { u } from 'pricesim'
import { request, service } from 'pricesim/model'
import { interRegionTransfer } from 'pricesim/aws'

const toOhio = interRegionTransfer('replica', { to: 'us-east-2' })
export const replicator = service('replicator', {
  deps: { toOhio },
  requests: ({ deps }) => ({
    replicate: request({ bytes: u.byte }, (r) => ({ calls: [deps.toOhio.send({ bytes: r.bytes })] })),
  }),
})`,
  ],
  seeAlso: ['interRegionTo', 'interRegion', 'internetEgress'],
  guide: 'catalog',
})

/** Traffic within us-east-1 via public or Elastic IPs, billed per GB in each direction. */
export const sameRegionPublic = transfer('same-region-public', 0.01, SOURCES.sameRegionPublic)

doc({
  name: 'sameRegionPublic',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'Traffic within us-east-1 over public or Elastic IPs: $0.01/GB, charged on each side.',
  signature: 'sameRegionPublic: BillingDimension<byte>',
  guidance:
    "- Dimension `aws.transfer.same-region-public`, family `aws.transfer`, retrieved 2026-09-24. Same usage type and rate as cross-AZ transfer, but charged even within one AZ. AWS's 1 GB/month free regional transfer is not modeled.",
  seeAlso: ['sameRegionPublicTransfer', 'interAz'],
  guide: 'catalog',
})

/**
 * Traffic between two resources in us-east-1 over public or Elastic IPs. `send` bills the sender's bytes
 * out and the receiver's bytes in, so each byte is billed twice.
 */
export const sameRegionPublicTransfer = (name = 'same-region-public') =>
  offering(`same-region-public:${name}`, {
    requests: () => ({
      send: request({ bytes: u.byte }, (r) => ({ bill: [bill(sameRegionPublic, r.bytes.mul(2))] })),
    }),
  })

doc({
  name: 'sameRegionPublicTransfer',
  kind: 'function',
  module: 'pricesim/aws',
  summary: 'Traffic between two resources in us-east-1 over public or Elastic IPs.',
  signature: 'sameRegionPublicTransfer(name?: string): Offering',
  params: [
    {
      name: 'name',
      type: 'string',
      optional: true,
      default: "'same-region-public'",
      doc: 'Node name is `same-region-public:<name>`.',
    },
  ],
  returns: "An offering; add it to a service's `deps`.",
  guidance:
    '- **Request:** `send({ bytes })` bills 2 × `bytes` at $0.01/GB: the sender pays for bytes out and the receiver for bytes in. Call it once per transfer, not once per side.',
  seeAlso: ['sameRegionPublic'],
  guide: 'catalog',
})
