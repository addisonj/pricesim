// AWS Direct Connect: a physical connection from a data center (at a DX location) into an AWS region.
//
// Two billing modes. Pay-as-you-go (https://aws.amazon.com/directconnect/pricing/):
//   - port-hours for each connection, by speed, billed to the account that owns the port. Dedicated ports cost
//     the same at every location outside Japan; hosted ports (via a DX partner) add the partner's own fees,
//     which are not modeled.
//   - data transfer OUT of AWS over the connection, per GB, by source region and DX location: $0.02/GB from
//     the contiguous US to a US location (Hawaii $0.035). Billed to the account that owns the AWS resources
//     sending the traffic (private VIF), or the VPC owner attached to a transit gateway (transit VIF).
//   - data transfer IN is free.
//
// Flat rate (https://docs.aws.amazon.com/directconnect/latest/PricingGuide/pricing-flat-rate.html), 10G and 100G
// dedicated connections only: a fixed hourly rate by speed and tier that includes data transfer out from the AWS
// Regions the tier covers, with no per-GB cap. The tier is set by the path (source Region ↔ DX location):
// Tier 1 same metro (us-east-1 ↔ Equinix DC2 Ashburn), Tier 2 regional, Tier 3 continental; Tiers 4–5 are not
// priced for us-east-1. A port-pair (two ports on different devices sharing the bandwidth) costs the same as one
// port: each port of the pair bills half the rate. Out from Regions outside the tier is billed at pay-as-you-go
// rates (not modeled). Colo, cross-connect and last-mile charges are never included.
//
// A private VIF to a virtual private gateway or a Direct Connect gateway adds no charge. A transit gateway adds
// $0.02/GB data processing (each direction, on entry) plus $0.05/hour per attachment; not modeled here.
// AWS doesn't document whether traffic from an AZ to the VGW also pays inter-AZ transfer; this offering
// assumes it doesn't (model it with an `interAz` edge if you want the sensitivity).
//
// Resiliency (https://aws.amazon.com/directconnect/sla/): 99.9% needs 2 connections at 2 locations; 99.99%
// needs 4 connections on separate devices at 2+ locations. A single connection has a 95% SLA.
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import { offering } from '../../model/node.ts'
import { bill, fixedCharge, request } from '../../model/request.ts'
import { dimension, type BillingDimension } from '../../pricing/dimension.ts'
import { SOURCES } from './sources.ts'

const dedicated = { '1G': 0.3, '10G': 2.25, '100G': 22.5, '400G': 85 } as const
const hosted = {
  '50M': 0.03,
  '100M': 0.06,
  '200M': 0.08,
  '300M': 0.12,
  '400M': 0.16,
  '500M': 0.2,
  '1G': 0.33,
  '2G': 0.66,
  '5G': 1.65,
  '10G': 2.48,
  '25G': 6.2,
} as const
export type DedicatedPort = keyof typeof dedicated
export type HostedPort = keyof typeof hosted

const opts = { family: 'aws.directconnect', source: SOURCES.directConnect }
const portDims = <K extends string>(kind: string, rates: Record<K, number>) =>
  Object.fromEntries(
    Object.entries(rates).map(([k, v]) => [k, dimension(`aws.directconnect.${kind}.${k}`, u.hour, v as number, opts)]),
  ) as Record<K, BillingDimension<{ s: 1 }>>

/** flat-rate USD per hour per single port (a pair's ports bill half each), us-east-1 price list 2026-09-17 */
const flatRate = {
  '10G': { 1: 10.96, 2: 17.12, 3: 23.29 },
  '100G': { 1: 102.74, 2: 160.96, 3: 219.18 },
} as const
export type FlatRateSpeed = keyof typeof flatRate
export type FlatRateTier = 1 | 2 | 3

export const directConnectRates = {
  /** port-hours per dedicated connection */
  dedicated: portDims('dedicated', dedicated),
  /** port-hours per hosted connection (partner fees extra) */
  hosted: portDims('hosted', hosted),
  /** data transfer out of AWS over DX, from a contiguous-US region to a US DX location */
  transferOut: dimension('aws.directconnect.transfer-out', u.GB, 0.02, opts),
  /** flat-rate port-hours per port of a port-pair (half the single-port rate), by speed and tier */
  flatRatePairPort: Object.fromEntries(
    (Object.keys(flatRate) as FlatRateSpeed[]).map((speed) => [
      speed,
      Object.fromEntries(
        ([1, 2, 3] as const).map((tier) => [
          tier,
          dimension(`aws.directconnect.flat-rate.${speed}-pair.tier${tier}`, u.hour, flatRate[speed][tier] / 2, opts),
        ]),
      ),
    ]),
  ) as Record<FlatRateSpeed, Record<FlatRateTier, BillingDimension<{ s: 1 }>>>,
  /** data transfer out included in a flat rate: $0, recorded so the volume shows */
  flatRateTransferOut: dimension('aws.directconnect.flat-rate.transfer-out', u.GB, 0, opts),
}

doc({
  name: 'directConnectRates',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'Direct Connect billing dimensions: port-hours by speed, transfer out, and flat-rate port-pairs.',
  signature: 'directConnectRates: { dedicated; hosted; transferOut; flatRatePairPort; flatRateTransferOut }',
  guidance: `
- \`dedicated[speed]\` USD per port-hour: 1G $0.30, 10G $2.25, 100G $22.50, 400G $85.
- \`hosted[speed]\` USD per port-hour (partner fees extra): 50M $0.03, 100M $0.06, 200M $0.08, 300M $0.12, 400M $0.16, 500M $0.20, 1G $0.33, 2G $0.66, 5G $1.65, 10G $2.48, 25G $6.20.
- \`transferOut\`: $0.02/GB out of AWS, contiguous-US region to a US location. Transfer in is free.
- \`flatRatePairPort[speed][tier]\`: per port of a port-pair, half the single-port hourly rate. Single-port rates: 10G tier 1/2/3 $10.96/$17.12/$23.29; 100G $102.74/$160.96/$219.18 (price list 2026-09-17).
- \`flatRateTransferOut\`: $0, so volume included in a flat rate still shows.
- Family \`aws.directconnect\`, retrieved 2026-09-24.`,
  seeAlso: ['directConnect'],
  guide: 'catalog',
})

type PortSpec =
  | { dedicated: DedicatedPort; hosted?: never; flatRate?: never }
  | { hosted: HostedPort; dedicated?: never; flatRate?: never }
  /** flat-rate port-pairs (`count` pairs, 2 ports each); transfer out within the tier included */
  | { flatRate: { speed: FlatRateSpeed; tier: FlatRateTier }; dedicated?: never; hosted?: never }

/**
 * `count` Direct Connect connections of one speed (e.g. `{ dedicated: '10G', count: 4 }` for the 99.99% SLA
 * layout), or `count` flat-rate port-pairs (`{ flatRate: { speed: '10G', tier: 1 } }`). `out({ bytes })` bills
 * bytes leaving AWS over the connection ($0 within a flat-rate tier); `in({ bytes })` is free.
 */
export const directConnect = (name: string, spec: PortSpec & { count?: number }) => {
  const count = spec.count ?? 1
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`directConnect '${name}': count must be a positive integer, got ${count}`)
  }
  const flat = spec.flatRate
  const port = flat
    ? directConnectRates.flatRatePairPort[flat.speed]?.[flat.tier]
    : spec.dedicated
      ? directConnectRates.dedicated[spec.dedicated]
      : directConnectRates.hosted[spec.hosted!]
  if (!port) throw new Error(`directConnect '${name}': unknown port speed or tier`)
  const transfer = flat ? directConnectRates.flatRateTransferOut : directConnectRates.transferOut
  return offering(`directconnect:${name}`, {
    // a flat-rate pair is two ports, each billing half the single-port rate
    fixed: [fixedCharge(port, flat ? 2 * count : count)],
    requests: () => ({
      /** `bytes` sent from AWS to the data center */
      out: request({ bytes: u.byte }, (r) => ({ bill: [bill(transfer, r.bytes)] })),
      /** `bytes` sent from the data center into AWS (free) */
      in: request({ bytes: u.byte }, () => ({})),
    }),
  })
}

doc({
  name: 'directConnect',
  kind: 'function',
  module: 'pricesim/aws',
  summary: 'AWS Direct Connect connections (pay-as-you-go dedicated or hosted ports) or flat-rate port-pairs.',
  signature:
    "directConnect(name: string, spec: ({ dedicated: '1G' | '10G' | '100G' | '400G' } | { hosted: HostedPort } | { flatRate: { speed: '10G' | '100G'; tier: 1 | 2 | 3 } }) & { count?: number }): Offering",
  params: [
    { name: 'name', type: 'string', doc: 'Node name is `directconnect:<name>`.' },
    { name: 'spec.dedicated', type: "'1G' | '10G' | '100G' | '400G'", optional: true, doc: 'Dedicated port speed.' },
    {
      name: 'spec.hosted',
      type: 'HostedPort',
      optional: true,
      doc: "Hosted port speed via a partner, `'50M'` to `'25G'`; partner fees are not modeled.",
    },
    {
      name: 'spec.flatRate',
      type: "{ speed: '10G' | '100G'; tier: 1 | 2 | 3 }",
      optional: true,
      doc: 'Flat-rate port-pair; tier 1 same metro, 2 regional, 3 continental. Transfer out within the tier is included.',
    },
    {
      name: 'spec.count',
      type: 'number',
      optional: true,
      default: '1',
      doc: 'Connections, or port-pairs with `flatRate`; a positive integer (throws otherwise).',
    },
  ],
  returns: "An offering; add it to a service's `deps`.",
  guidance: `
- Give exactly one of \`dedicated\`, \`hosted\`, \`flatRate\`.
- **Requests:** \`out({ bytes })\`: bytes from AWS to the data center, $0.02/GB (pay-as-you-go) or $0 (flat rate). \`in({ bytes })\`: into AWS, free.
- **Fixed:** \`count\` ports × the port-hour rate; with \`flatRate\`, \`count\` pairs = 2 × count ports at half the single-port rate each, so a pair costs one port rate.
- Resiliency: 99.9% needs 2 connections at 2 locations; 99.99% needs 4 connections on separate devices at 2+ locations (e.g. \`{ dedicated: '10G', count: 4 }\`).
- Not modeled: colo, cross-connect and last-mile charges; transit gateway processing and attachments; flat-rate transfer from regions outside the tier. Inter-AZ transfer to the VGW is assumed free.`,
  examples: [
    `import { u } from 'pricesim'
import { request, service } from 'pricesim/model'
import { directConnect } from 'pricesim/aws'

const dx = directConnect('onprem', { dedicated: '10G', count: 4 })
export const sync = service('sync', {
  deps: { dx },
  requests: ({ deps }) => ({
    download: request({ bytes: u.byte }, (r) => ({ calls: [deps.dx.out({ bytes: r.bytes })] })),
    upload: request({ bytes: u.byte }, (r) => ({ calls: [deps.dx.in({ bytes: r.bytes })] })),
  }),
})`,
    `import { directConnect } from 'pricesim/aws'

// one 10G tier-1 port-pair: $10.96/hour, transfer out included
const flat = directConnect('onprem-flat', { flatRate: { speed: '10G', tier: 1 } })`,
  ],
  seeAlso: ['directConnectRates'],
  guide: 'catalog',
})
