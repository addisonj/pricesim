// DynamoDB on-demand tables: write/read request units by item size, indexed storage with a 25 GB free tier.
// Rates from dynamodb.gen.ts.
import { ceil, max, q } from '../../core/expr.ts'
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import { offering } from '../../model/node.ts'
import { bill, gauge, request } from '../../model/request.ts'
import { dimension, freeTier } from '../../pricing/dimension.ts'
import { dynamodbRates } from './dynamodb.gen.ts'
import { SOURCES } from './sources.ts'

/** Indexed storage free each month (the price data lists the free tier as a $0 rate without its size). */
const FREE_STORAGE_GB = 25

export const dynamodbOnDemand = {
  writeUnits: dimension('aws.dynamodb.ondemand.wru', u.op, dynamodbRates['PayPerRequest Write Request Units'].usd, {
    family: 'aws.dynamodb',
    source: SOURCES.dynamodb,
  }),
  readUnits: dimension('aws.dynamodb.ondemand.rru', u.op, dynamodbRates['PayPerRequest Read Request Units'].usd, {
    family: 'aws.dynamodb',
    source: SOURCES.dynamodb,
  }),
  storage: dimension(
    'aws.dynamodb.storage',
    u.GB.mul(u.month),
    freeTier(FREE_STORAGE_GB, dynamodbRates['Data Storage Indexed GB-Mo'].usd),
    { family: 'aws.dynamodb', source: SOURCES.dynamodb },
  ),
}

doc({
  name: 'dynamodbOnDemand',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'DynamoDB on-demand billing dimensions: write request units, read request units, indexed storage.',
  signature: 'dynamodbOnDemand: { writeUnits; readUnits; storage }',
  guidance: `
- \`writeUnits\` $0.625 per million WRUs; \`readUnits\` $0.125 per million RRUs; \`storage\` $0.25/GB-month after 25 GB free (the free tier applies once to the shared dimension, i.e. across all tables in the scenario).
- Family \`aws.dynamodb\`, us-east-1, generated from the DynamoDB price list retrieved 2026-09-24.`,
  seeAlso: ['dynamoTable'],
  guide: 'catalog',
})

/** An on-demand table. `gsis` global secondary indexes each repeat the write. */
export const dynamoTable = (name: string, opts: { gsis?: number } = {}) => {
  const writeAmp = 1 + (opts.gsis ?? 0)
  return offering(`dynamodb:${name}`, {
    gauges: { stored: gauge(u.byte, { billAs: dynamodbOnDemand.storage }) },
    requests: () => ({
      /** PutItem/UpdateItem: 1 WRU per 1 KiB of item size (rounded up, at least 1), per table + GSI */
      write: request({ bytes: u.byte }, (r) => ({
        bill: [
          bill(
            dynamodbOnDemand.writeUnits,
            max(q(1, u.one), ceil(r.bytes.div(q(1, u.KiB))))
              .mul(writeAmp)
              .mul(q(1, u.op)),
          ),
        ],
      })),
      /** GetItem, eventually consistent: 0.5 RRU per 4 KB (rounded up) */
      read: request({ bytes: u.byte }, (r) => ({
        bill: [
          bill(
            dynamodbOnDemand.readUnits,
            max(q(1, u.one), ceil(r.bytes.div(q(4, u.KiB))))
              .mul(0.5)
              .mul(q(1, u.op)),
          ),
        ],
      })),
      /** Query, eventually consistent: 0.5 RRU per 4 KB of total returned data (rounded up) */
      query: request({ bytes: u.byte }, (r) => ({
        bill: [
          bill(
            dynamodbOnDemand.readUnits,
            max(q(1, u.one), ceil(r.bytes.div(q(4, u.KiB))))
              .mul(0.5)
              .mul(q(1, u.op)),
          ),
        ],
      })),
    }),
  })
}

doc({
  name: 'dynamoTable',
  kind: 'function',
  module: 'pricesim/aws',
  summary: 'A DynamoDB on-demand table offering: item writes, reads and queries by size, and stored bytes.',
  signature: 'dynamoTable(name: string, opts?: { gsis?: number }): Offering',
  params: [
    { name: 'name', type: 'string', doc: 'Node name is `dynamodb:<name>`.' },
    {
      name: 'opts.gsis',
      type: 'number',
      optional: true,
      default: '0',
      doc: 'Global secondary indexes; each repeats every write (write units × (1 + gsis)).',
    },
  ],
  returns: "An offering; add it to a service's `deps`.",
  guidance: `
- **Requests** (all take \`{ bytes }\`):
  - \`write\`: \`max(1, ceil(bytes / 1 KiB)) × (1 + gsis)\` WRUs ($0.625 per million).
  - \`read\`: eventually consistent GetItem, \`0.5 × max(1, ceil(bytes / 4 KiB))\` RRUs ($0.125 per million).
  - \`query\`: the same formula over the total bytes returned.
- Unit sizes are 1 KiB and 4 KiB (1,024-byte KB, as DynamoDB counts item size); every request bills at least one unit. Strongly consistent and transactional requests are not modeled; bill \`dynamodbOnDemand.readUnits\` / \`.writeUnits\` from your own offering for them.
- **Gauge:** \`stored\` (bytes), $0.25/GB-month after 25 GB free. GSI storage is not added: include it in the bytes you map.`,
  examples: [
    `import { q, u } from 'pricesim'
import { gauge, request, service } from 'pricesim/model'
import { dynamoTable } from 'pricesim/aws'

const sessions = dynamoTable('sessions', { gsis: 1 })
export const auth = service('auth', {
  deps: { sessions },
  gauges: { sessions: gauge(u.count) },
  requests: ({ deps }) => ({
    login: request({}, () => ({ calls: [deps.sessions.write({ bytes: q(800, u.byte) })] })),
    check: request({}, () => ({ calls: [deps.sessions.read({ bytes: q(800, u.byte) })] })),
  }),
  gaugeMap: (g, { deps }) => [deps.sessions.gauges.stored(g.sessions.mul(q(1, u.KB.div(u.count))))],
})`,
  ],
  seeAlso: ['dynamodbOnDemand'],
  guide: 'catalog',
})
