// AWS PrivateLink interface VPC endpoints (consumer side), us-east-1.
//
// An interface endpoint bills an hourly charge for each AZ it is provisioned in (`VpcEndpoint-Hours`), plus
// a per-GB charge on data processed in either direction (`VpcEndpoint-Bytes`), tiered by monthly volume:
// $0.01 for the first 1 PB, $0.006 for the next 4 PB, $0.004 above 5 PB. The price list gives the bounds in
// GB with 1 PB = 1,048,576 GB. AWS aggregates that volume across all interface endpoints in the region of an
// account; here every endpoint shares the dimension, so the tiers pool across the scenario.
//
// The endpoint *service* (provider side) has no PrivateLink charge within a region: the provider pays for the
// Network Load Balancer behind it (`networkLoadBalancer`) and nothing per endpoint or per GB. Cross-region
// PrivateLink adds a provider charge of $0.05/hour per active remote region (`VpcEndpoint-Service-Hours`)
// and inter-region data transfer billed to the endpoint owner; neither is modeled here.
//
// Gateway Load Balancer endpoints, resource endpoints and service-network endpoints have other rates and are
// not modeled. Gateway endpoints (S3, DynamoDB) are free.
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import { offering } from '../../model/node.ts'
import { bill, fixedCharge, request } from '../../model/request.ts'
import { dimension, tiered } from '../../pricing/dimension.ts'
import { SOURCES } from './sources.ts'

const PB = 1024 * 1024 // GB, as in the price list

export const privateLinkRates = {
  /** endpoint-hours, per AZ */
  hours: dimension('aws.vpc.endpoint.hours', u.hour, 0.01, { family: 'aws.vpc', source: SOURCES.privateLink }),
  processed: dimension(
    'aws.vpc.endpoint.processed',
    u.GB,
    tiered([
      { upTo: PB, rate: 0.01 },
      { upTo: 5 * PB, rate: 0.006 },
      { upTo: null, rate: 0.004 },
    ]),
    { family: 'aws.vpc', source: SOURCES.privateLink },
  ),
}

doc({
  name: 'privateLinkRates',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'PrivateLink interface endpoint billing dimensions: endpoint-hours per AZ and tiered GB processed.',
  signature: 'privateLinkRates: { hours; processed }',
  guidance: `
- \`hours\`: $0.01 per endpoint-AZ-hour. \`processed\`: $0.01/GB for the first 1 PB, $0.006 for the next 4 PB, $0.004 above 5 PB (1 PB = 1,048,576 GB).
- Family \`aws.vpc\`, us-east-1, retrieved 2026-09-24. All endpoints share \`processed\`, so tiers apply to the scenario's total.`,
  seeAlso: ['privateLinkEndpoint'],
  guide: 'catalog',
})

/** An interface VPC endpoint provisioned in `azs` AZs. */
export const privateLinkEndpoint = (name: string, opts: { azs: number }) => {
  if (!Number.isInteger(opts.azs) || opts.azs < 1) {
    throw new Error(`privateLinkEndpoint '${name}': azs must be a positive integer, got ${opts.azs}`)
  }
  return offering(`privatelink:${name}`, {
    fixed: [fixedCharge(privateLinkRates.hours, opts.azs)],
    requests: () => ({
      /** `bytes` processed by the endpoint, in either direction */
      process: request({ bytes: u.byte }, (r) => ({ bill: [bill(privateLinkRates.processed, r.bytes)] })),
    }),
  })
}

doc({
  name: 'privateLinkEndpoint',
  kind: 'function',
  module: 'pricesim/aws',
  summary: 'An AWS PrivateLink interface VPC endpoint (consumer side) in `azs` AZs.',
  signature: 'privateLinkEndpoint(name: string, opts: { azs: number }): Offering',
  params: [
    { name: 'name', type: 'string', doc: 'Node name is `privatelink:<name>`.' },
    {
      name: 'opts.azs',
      type: 'number',
      doc: 'AZs the endpoint is provisioned in; a positive integer (throws otherwise).',
    },
  ],
  returns: "An offering; add it to a service's `deps`.",
  guidance: `
- **Request:** \`process({ bytes })\`: bytes through the endpoint in either direction, $0.01/GB, tiered down to $0.004 above 5 PB.
- **Fixed:** \`azs\` × $0.01 per hour.
- The endpoint *service* (provider side) has no PrivateLink charge within a region: model its \`networkLoadBalancer\`. Cross-region PrivateLink, Gateway Load Balancer endpoints and resource endpoints are not modeled; gateway endpoints (S3, DynamoDB) are free.`,
  examples: [
    `import { u } from 'pricesim'
import { request, service } from 'pricesim/model'
import { privateLinkEndpoint } from 'pricesim/aws'

const endpoint = privateLinkEndpoint('vendor-api', { azs: 3 })
export const client = service('client', {
  account: 'customer',
  deps: { endpoint },
  requests: ({ deps }) => ({
    call: request({ bytes: u.byte }, (r) => ({ calls: [deps.endpoint.process({ bytes: r.bytes })] })),
  }),
})`,
  ],
  seeAlso: ['privateLinkRates', 'networkLoadBalancer'],
  guide: 'catalog',
})
