// NAT gateways: an hourly charge per gateway plus a per-GB data processing charge.
//
// Traffic that a NAT gateway sends to the internet is also billed as internet data transfer out. This
// offering does not bill that: call `internetEgress` as well. Provisioned-bandwidth NAT gateways are not
// modeled.
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import { offering } from '../../model/node.ts'
import { bill, fixedCharge, request } from '../../model/request.ts'
import { dimension } from '../../pricing/dimension.ts'
import { SOURCES } from './sources.ts'

export const natGatewayRates = {
  hours: dimension('aws.vpc.natgateway.hours', u.hour, 0.045, { family: 'aws.vpc', source: SOURCES.natGateway }),
  processed: dimension('aws.vpc.natgateway.processed', u.GB, 0.045, {
    family: 'aws.vpc',
    source: SOURCES.natGateway,
  }),
}

doc({
  name: 'natGatewayRates',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'NAT gateway billing dimensions: $0.045 per gateway-hour and $0.045 per GB processed.',
  signature: 'natGatewayRates: { hours; processed }',
  guidance: '- Family `aws.vpc`, us-east-1, retrieved 2026-09-24.',
  seeAlso: ['natGateway'],
  guide: 'catalog',
})

/** `count` NAT gateways (typically one per AZ). */
export const natGateway = (name: string, opts: { count?: number } = {}) =>
  offering(`natgateway:${name}`, {
    fixed: [fixedCharge(natGatewayRates.hours, opts.count ?? 1)],
    requests: () => ({
      /** `bytes` processed by the gateway, in either direction */
      process: request({ bytes: u.byte }, (r) => ({ bill: [bill(natGatewayRates.processed, r.bytes)] })),
    }),
  })

doc({
  name: 'natGateway',
  kind: 'function',
  module: 'pricesim/aws',
  summary: 'NAT gateways (typically one per AZ): hourly charge plus per-GB processing.',
  signature: 'natGateway(name: string, opts?: { count?: number }): Offering',
  params: [
    { name: 'name', type: 'string', doc: 'Node name is `natgateway:<name>`.' },
    { name: 'opts.count', type: 'number', optional: true, default: '1', doc: 'Gateways, each billed $0.045/hour.' },
  ],
  returns: "An offering; add it to a service's `deps`.",
  guidance: `
- **Request:** \`process({ bytes })\`: bytes through the gateway in either direction, $0.045/GB.
- **Fixed:** \`count\` × $0.045 per hour.
- Traffic to the internet also pays internet transfer out: call \`internetEgress\` too. Provisioned-bandwidth NAT gateways are not modeled.`,
  examples: [
    `import { u } from 'pricesim'
import { request, service } from 'pricesim/model'
import { internetEgress, natGateway } from 'pricesim/aws'

const nat = natGateway('egress', { count: 3 })
const internet = internetEgress()
export const fetcher = service('fetcher', {
  deps: { nat, internet },
  requests: ({ deps }) => ({
    // responses come in through the NAT; the requests going out are small and ignored here
    fetch: request({ bytes: u.byte }, (r) => ({ calls: [deps.nat.process({ bytes: r.bytes })] })),
    push: request({ bytes: u.byte }, (r) => ({
      calls: [deps.nat.process({ bytes: r.bytes }), deps.internet.send({ bytes: r.bytes })],
    })),
  }),
})`,
  ],
  seeAlso: ['natGatewayRates', 'internetEgress'],
  guide: 'catalog',
})
