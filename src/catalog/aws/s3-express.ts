// S3 Express One Zone directory buckets: storage per GB-month, PUT-class and GET-class requests, and
// per-GB upload/retrieval charges. Data lives in a single AZ, which callers read from `placement`.
//
// The per-GB charges apply to ALL bytes of a PUT/GET. Before 2025-04-10 they applied only to the part of a
// request above 512 KB; AWS removed that threshold when it cut the per-GB rates by 60%
// (https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-s3-express-one-zone-reduces-storage-request-prices/).
// The rates below are the post-change rates, so they are billed on every byte.
import { ceil, max, q, type Expr } from '../../core/expr.ts'
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import { offering, type AnyCallable, type GraphNode } from '../../model/node.ts'
import { bill, gauge, request } from '../../model/request.ts'
import { dimension } from '../../pricing/dimension.ts'
import { SOURCES } from './sources.ts'

export const s3Express = {
  storage: dimension('aws.s3express.storage', u.GB.mul(u.month), 0.11, { family: 'aws.s3', source: SOURCES.s3Express }),
  putRequests: dimension('aws.s3express.put', u.req, 0.00113 / 1000, { family: 'aws.s3', source: SOURCES.s3Express }),
  getRequests: dimension('aws.s3express.get', u.req, 0.00003 / 1000, { family: 'aws.s3', source: SOURCES.s3Express }),
  upload: dimension('aws.s3express.upload', u.GB, 0.0032, { family: 'aws.s3', source: SOURCES.s3Express }),
  retrieval: dimension('aws.s3express.retrieval', u.GB, 0.0006, { family: 'aws.s3', source: SOURCES.s3Express }),
}

doc({
  name: 's3Express',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'S3 Express One Zone billing dimensions: storage, requests, and per-GB upload and retrieval.',
  signature: 's3Express: { storage; putRequests; getRequests; upload; retrieval }',
  guidance: `
- \`storage\` $0.11/GB-month; \`putRequests\` $0.00113 per 1,000; \`getRequests\` $0.00003 per 1,000; \`upload\` $0.0032/GB; \`retrieval\` $0.0006/GB.
- The per-GB charges apply to every byte (AWS dropped the 512 KB threshold on 2025-04-10).
- Family \`aws.s3\`, us-east-1, retrieved 2026-09-24.`,
  seeAlso: ['s3ExpressBucket'],
  guide: 'catalog',
})

/** Where an offering's data lives. The network model will read it to pick cross-AZ fractions (DESIGN §6.3). */
export type Placement = { readonly kind: 'singleAz' } | { readonly kind: 'regional' }

/** S3 Express One Zone stores data in one AZ: clients in other AZs of the region reach it across AZs. */
export const s3ExpressPlacement: Placement = { kind: 'singleAz' }

doc({
  name: 's3ExpressPlacement',
  kind: 'const',
  module: 'pricesim/aws',
  summary: "The placement S3 Express buckets declare: `{ kind: 'singleAz' }`.",
  guide: 'catalog',
  seeAlso: ['placementOf'],
})

// Side channel for offering placement, keyed by graph node, so callables keep exactly the engine's shape.
const placements = new WeakMap<GraphNode, Placement>()

/** The placement a catalog offering declares, or undefined if it declares none (e.g. regional services). */
export const placementOf = (node: AnyCallable): Placement | undefined => placements.get(node.$node)

doc({
  name: 'placementOf',
  kind: 'function',
  module: 'pricesim/aws',
  summary: 'The placement a catalog offering declares (`singleAz` for S3 Express buckets), or undefined if none.',
  signature: 'placementOf(node: Callable): Placement | undefined',
  guidance:
    '- Metadata only: the engine does not read placement yet, so model cross-AZ access to a single-AZ bucket with an explicit `edge`. Only `s3ExpressBucket` declares one today.',
  seeAlso: ['s3ExpressBucket', 'edge'],
  guide: 'catalog',
})

/**
 * An S3 Express One Zone directory bucket. Objects larger than `partSize` are uploaded as multipart PUTs
 * (one PUT-class request per part).
 *
 * `placementOf(bucket)` returns `singleAz`. The engine doesn't read placement yet, so cross-AZ access to
 * the bucket still has to be modeled with an explicit edge.
 */
export const s3ExpressBucket = (name: string, opts: { partSize?: Expr<{ byte: 1 }> } = {}) => {
  const partSize = opts.partSize ?? q(16, u.MiB)
  const node = offering(`s3express:${name}`, {
    gauges: { stored: gauge(u.byte, { billAs: s3Express.storage }) },
    requests: () => ({
      put: request({ bytes: u.byte }, (r) => ({
        bill: [
          bill(s3Express.putRequests, max(q(1, u.one), ceil(r.bytes.div(partSize))).mul(q(1, u.req))),
          bill(s3Express.upload, r.bytes),
        ],
      })),
      get: request({ bytes: u.byte }, (r) => ({
        bill: [bill(s3Express.getRequests, q(1, u.req)), bill(s3Express.retrieval, r.bytes)],
      })),
    }),
  })
  placements.set(node.$node, s3ExpressPlacement)
  return node
}

doc({
  name: 's3ExpressBucket',
  kind: 'function',
  module: 'pricesim/aws',
  summary:
    'An S3 Express One Zone directory bucket offering: PUT and GET requests with per-GB charges, and stored bytes.',
  signature: 's3ExpressBucket(name: string, opts?: { partSize?: Expr<byte> }): Offering',
  params: [
    { name: 'name', type: 'string', doc: 'Node name is `s3express:<name>`.' },
    {
      name: 'opts.partSize',
      type: 'Expr<byte>',
      optional: true,
      default: 'q(16, u.MiB)',
      doc: 'Multipart part size: a PUT bills one request per started part.',
    },
  ],
  returns: 'An offering, with `placementOf(bucket)` = `singleAz`.',
  guidance: `
- **Requests:** \`put({ bytes })\` bills \`max(1, ceil(bytes / partSize))\` PUT requests ($0.00113 per 1,000) plus \`bytes\` of upload ($0.0032/GB). \`get({ bytes })\` bills one GET request ($0.00003 per 1,000) plus \`bytes\` of retrieval ($0.0006/GB).
- **Gauge:** \`stored\` (bytes), billed at $0.11/GB-month.
- Data lives in one AZ, but the engine doesn't read placement: add an \`edge\` for clients in other AZs if cross-AZ transfer matters.`,
  examples: [
    `import { u } from 'pricesim'
import { request, service } from 'pricesim/model'
import { s3ExpressBucket } from 'pricesim/aws'

const hot = s3ExpressBucket('hot')
export const cache = service('cache', {
  deps: { hot },
  requests: ({ deps }) => ({
    read: request({ bytes: u.byte }, (r) => ({ calls: [deps.hot.get({ bytes: r.bytes })] })),
  }),
})`,
  ],
  seeAlso: ['s3Express', 's3Bucket', 'placementOf'],
  guide: 'catalog',
})
