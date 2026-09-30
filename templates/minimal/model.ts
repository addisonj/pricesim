// A pricesim model: `pricesim eval model.ts` evaluates the default export.
// Look things up as you go: `pricesim guide`, `pricesim api <word>`, `pricesim describe <name>`.
import { param, pricing, q, scenario, series, u, workload } from 'pricesim'
import { gauge, instancePool, request, service } from 'pricesim/model'
import { ec2, interAz, s3Bucket } from 'pricesim/aws'

// units used below
const coreMs = u.vCPU.mul(u.ms) // CPU time: 1 core·ms
const perSecond = u.req.div(u.s)

// inputs you're unsure of: params can be swept (`pricesim sweep model.ts --var cpuPerWrite=1,2,4`)
const cpuPerWrite = param('cpuPerWrite', q(2, coreMs))

// 1. dependencies: offerings from the catalog (`pricesim api --module pricesim/aws`), or your own
const archive = s3Bucket('archive')

// 2. the root service: pools, request types, gauges
export const api = service('api', {
  deps: { archive },
  pools: { nodes: instancePool('api-nodes', { instance: ec2['c7g.xlarge'], min: 2, loadFactor: 0.7, azs: 2 }) },
  gauges: { objects: gauge(u.count) },
  requests: ({ deps, pools }) => ({
    write: request({ bytes: u.byte }, (r) => ({
      use: [pools.nodes.cpu(cpuPerWrite), pools.nodes.network(r.bytes)],
      calls: [deps.archive.put({ bytes: r.bytes })],
    })),
  }),
  // every object is ~100 KB in S3
  gaugeMap: (g, { deps }) => [deps.archive.gauges.stored(g.objects.mul(q(100, u.KB.div(u.count))))],
})

// 3. the workload: rates over time, request attributes, gauge levels
const typical = workload(api, {
  requests: {
    write: { rate: series.diurnal({ mean: q(50, perSecond), peakToMean: 1.5 }), attrs: { bytes: q(100, u.KB) } },
  },
  gauges: { objects: q(10_000_000, u.count) },
})

// 4. the scenario: what the CLI runs
export default scenario({ name: 'api', root: api, workload: typical, pricing: pricing(), interAz })
