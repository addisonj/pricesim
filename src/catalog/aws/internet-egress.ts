// Data transfer out from us-east-1 to the internet. It is tiered by monthly volume after a 100 GB/month
// free tier. That free tier is aggregated across all AWS services and regions; here it applies to this one
// dimension. The tiers pool across the scenario because every consumer shares this billing dimension. The
// price list gives tier bounds in GB with 1 TB = 1024 GB.
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import { offering } from '../../model/node.ts'
import { bill, request } from '../../model/request.ts'
import { dimension, freeTier, tiered } from '../../pricing/dimension.ts'
import { SOURCES } from './sources.ts'

const TB = 1024 // GB, as in the price list

export const internetEgressOut = dimension(
  'aws.transfer.internet-out',
  u.GB,
  freeTier(
    100,
    tiered([
      { upTo: 10 * TB, rate: 0.09 },
      { upTo: 50 * TB, rate: 0.085 },
      { upTo: 150 * TB, rate: 0.07 },
      { upTo: null, rate: 0.05 },
    ]),
  ),
  { family: 'aws.transfer', source: SOURCES.internetEgress },
)

doc({
  name: 'internetEgressOut',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'Data transfer out from us-east-1 to the internet: per GB, 100 GB/month free, then volume tiers.',
  signature: 'internetEgressOut: BillingDimension<byte>',
  guidance: `
- After the first 100 GB/month (free): $0.09/GB up to 10 TB, $0.085 to 50 TB, $0.07 to 150 TB, $0.05 above (1 TB = 1,024 GB, as in the price list). The tier bounds count usage after the free 100 GB.
- Family \`aws.transfer\`, retrieved 2026-09-24. AWS aggregates the free tier across services and regions; here it applies to this dimension only.`,
  seeAlso: ['internetEgress'],
  guide: 'catalog',
})

/** Data sent from the region to the internet. Transfer in from the internet is free and not modeled. */
export const internetEgress = (name = 'internet') =>
  offering(`internet-egress:${name}`, {
    requests: () => ({
      send: request({ bytes: u.byte }, (r) => ({ bill: [bill(internetEgressOut, r.bytes)] })),
    }),
  })

doc({
  name: 'internetEgress',
  kind: 'function',
  module: 'pricesim/aws',
  summary: 'Data sent from the region to the internet, billed on `internetEgressOut`.',
  signature: 'internetEgress(name?: string): Offering',
  params: [
    {
      name: 'name',
      type: 'string',
      optional: true,
      default: "'internet'",
      doc: 'Node name is `internet-egress:<name>`.',
    },
  ],
  returns: "An offering; add it to a service's `deps`.",
  guidance: `
- **Request:** \`send({ bytes })\`: bytes out to the internet, 100 GB/month free then $0.09 → $0.05/GB by volume.
- Every \`internetEgress\` node shares the dimension, so the free tier and tiers apply to the scenario's total.
- Transfer in from the internet is free and not modeled. NAT gateway and load balancer charges are separate.`,
  examples: [
    `import { u } from 'pricesim'
import { request, service } from 'pricesim/model'
import { internetEgress } from 'pricesim/aws'

const internet = internetEgress()
export const cdnOrigin = service('origin', {
  deps: { internet },
  requests: ({ deps }) => ({
    serve: request({ bytes: u.byte }, (r) => ({ calls: [deps.internet.send({ bytes: r.bytes })] })),
  }),
})`,
  ],
  seeAlso: ['internetEgressOut', 'natGateway', 'interRegionTransfer'],
  guide: 'catalog',
})
