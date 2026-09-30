// Data transfer between AZs in the same region: $0.01/GB in each direction.
// Its family, 'aws.transfer.inter-az', sits under 'aws.transfer', so a private-pricing discount can target
// inter-AZ alone (`familyDiscounts: { 'aws.transfer.inter-az': 0.4 }`) or all transfer ('aws.transfer').
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import { dimension } from '../../pricing/dimension.ts'
import { SOURCES } from './sources.ts'

export const interAz = dimension('aws.transfer.inter-az', u.GB, 0.01, {
  family: 'aws.transfer.inter-az',
  source: SOURCES.transfer,
})

doc({
  name: 'interAz',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: "Cross-AZ data transfer in us-east-1, $0.01/GB; pass it as a scenario's `interAz`.",
  signature: 'interAz: BillingDimension<byte>',
  guidance: `
- Dimension \`aws.transfer.inter-az\`, $0.01 per GB (10^9 bytes), family \`aws.transfer.inter-az\`, retrieved 2026-09-24.
- The engine bills request \`net\` edges on it, for both the sending and the receiving side (2 × the crossing bytes). A scenario whose requests declare edges throws without it.
- The family sits under \`aws.transfer\`, so \`familyDiscounts\` can target inter-AZ alone (\`'aws.transfer.inter-az'\`) or all transfer (\`'aws.transfer'\`).`,
  examples: [
    `import { pricing, scenario, service, workload } from 'pricesim'
import { interAz } from 'pricesim/aws'

const root = service('root', { requests: () => ({}) })
export const s = scenario({ name: 'base', root, workload: workload(root, { requests: {} }), pricing: pricing(), interAz })`,
  ],
  seeAlso: ['edge', 'scenario', 'sameRegionPublic'],
  guide: 'catalog',
})
