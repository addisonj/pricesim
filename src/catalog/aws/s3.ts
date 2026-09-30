// S3 Standard buckets: tiered storage, PUT-class and GET-class requests (rates from s3.gen.ts). Storage tiers pool across the
// scenario because the billing dimension is shared by every bucket.
import { ceil, q } from '../../core/expr.ts'
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import { offering } from '../../model/node.ts'
import { bill, gauge, request } from '../../model/request.ts'
import { dimension, tiered } from '../../pricing/dimension.ts'
import { s3Rates } from './s3.gen.ts'
import { SOURCES } from './sources.ts'

const TB = 1000 // GB
const rate = (name: keyof typeof s3Rates): number => s3Rates[name].usd
export const s3Standard = {
  storage: dimension(
    'aws.s3.standard.storage',
    u.GB.mul(u.month),
    tiered([
      { upTo: 50 * TB, rate: rate('Standard Storage First 50 TB per GB Mo') },
      { upTo: 500 * TB, rate: rate('Standard Storage Next 450 TB per GB Mo') },
      { upTo: null, rate: rate('Standard Storage Over 500 TB per GB Mo') },
    ]),
    { family: 'aws.s3', source: SOURCES.s3 },
  ),
  putRequests: dimension('aws.s3.standard.put', u.req, rate('PUT COPY/POST or LIST requests per Requests'), {
    family: 'aws.s3',
    source: SOURCES.s3,
  }),
  getRequests: dimension('aws.s3.standard.get', u.req, rate('GET and all other requests per Requests'), {
    family: 'aws.s3',
    source: SOURCES.s3,
  }),
}

doc({
  name: 's3Standard',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'S3 Standard billing dimensions: tiered storage, PUT-class and GET-class requests.',
  signature: 's3Standard: { storage; putRequests; getRequests }',
  guidance: `
- \`storage\`: per GB-month, tiered on the scenario's total: $0.023 for the first 50 TB, $0.022 for the next 450 TB, $0.021 above 500 TB (1 TB = 1,000 GB here).
- \`putRequests\`: $0.005 per 1,000 (PUT, COPY, POST, LIST). \`getRequests\`: $0.0004 per 1,000 (GET and all other).
- Family \`aws.s3\`, us-east-1, generated from the S3 price list retrieved 2026-09-24.`,
  seeAlso: ['s3Bucket'],
  guide: 'catalog',
})

/** An S3 Standard bucket. Objects larger than `partSize` are uploaded as multipart PUTs. */
export const s3Bucket = (name: string, opts: { partSize?: ReturnType<typeof q<{ byte: 1 }>> } = {}) => {
  const partSize = opts.partSize ?? q(16, u.MiB)
  return offering(`s3:${name}`, {
    gauges: { stored: gauge(u.byte, { billAs: s3Standard.storage }) },
    requests: () => ({
      put: request({ bytes: u.byte }, (r) => ({
        bill: [bill(s3Standard.putRequests, ceil(r.bytes.div(partSize)).mul(q(1, u.req)))],
      })),
      get: request({ bytes: u.byte }, () => ({
        bill: [bill(s3Standard.getRequests, q(1, u.req))],
      })),
    }),
  })
}

doc({
  name: 's3Bucket',
  kind: 'function',
  module: 'pricesim/aws',
  summary: 'An S3 Standard bucket offering: PUT and GET requests, and stored bytes.',
  signature: 's3Bucket(name: string, opts?: { partSize?: Expr<byte> }): Offering',
  params: [
    { name: 'name', type: 'string', doc: 'Node name is `s3:<name>`.' },
    {
      name: 'opts.partSize',
      type: 'Expr<byte>',
      optional: true,
      default: 'q(16, u.MiB)',
      doc: 'Multipart part size: a PUT of `bytes` bills `ceil(bytes / partSize)` PUT requests.',
    },
  ],
  returns: "An offering; add it to a service's `deps` and call it from request bodies.",
  guidance: `
- **Requests:** \`put({ bytes })\` bills \`ceil(bytes / partSize)\` PUT-class requests ($0.005 per 1,000). A 0-byte put bills none. \`get({ bytes })\` bills one GET-class request ($0.0004 per 1,000) whatever the size.
- **Gauge:** \`stored\` (bytes), billed as GB-months of S3 Standard storage, tiered ($0.023 / $0.022 / $0.021 per GB-month at 50 TB and 500 TB). Map a service gauge onto it with \`gaugeMap\`.
- All buckets share the \`s3Standard\` dimensions, so storage tiers apply to the scenario's total.
- Not billed: data transfer (use \`internetEgress\` for bytes to the internet, edges for cross-AZ), lifecycle, other storage classes, the requests that start and complete a multipart upload.`,
  examples: [
    `import { q, u } from 'pricesim'
import { gauge, request, service } from 'pricesim/model'
import { s3Bucket } from 'pricesim/aws'

const files = s3Bucket('files')
export const uploads = service('uploads', {
  deps: { files },
  gauges: { files: gauge(u.count) },
  requests: ({ deps }) => ({
    upload: request({ bytes: u.byte }, (r) => ({ calls: [deps.files.put({ bytes: r.bytes })] })),
    download: request({ bytes: u.byte }, (r) => ({ calls: [deps.files.get({ bytes: r.bytes })] })),
  }),
  // every file is ~500 KB in S3
  gaugeMap: (g, { deps }) => [deps.files.gauges.stored(g.files.mul(q(500, u.KB.div(u.count))))],
})`,
  ],
  seeAlso: ['s3Standard', 's3ExpressBucket', 'offering'],
  guide: 'catalog',
})
