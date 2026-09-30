// unitCosts: each root request type evaluated alone at a constant rate.
import { describe, expect, it } from 'vitest'
import {
  bill,
  dimension,
  gauge,
  instancePool,
  offering,
  q,
  request,
  scenario,
  service,
  u,
  unitCosts,
  workload,
  withWorkload,
} from '../../src/index.ts'
import { cpuS, H, instanceType, list, M, rps, storageDim } from './fixtures.ts'

// get:  1 billed request ($1/M) + 100 millicore·s on a $3.60/h, 1000-millicore instance (min 1, loadFactor 1)
//       → CPU per request = 0.1 instance-second = 0.1 × $0.001 = $0.0001 → $100 per million
// put:  1 billed request + a call writing 1 MB ($1/GB → $1000 per million)
// gauge: 1000 GB stored at $0.10/GB-month = $100
const reqs = dimension('t.uc.req', u.req, 1e-6)
const written = dimension('t.uc.written', u.GB, 1)
const stored = storageDim('t.uc.stored')
const vm = instanceType('uc-vm', { usdPerHour: 3.6 })
const blob = offering('blob', {
  gauges: { bytes: gauge(u.byte, { billAs: stored }) },
  requests: () => ({ put: request({ bytes: u.byte }, (r) => ({ bill: [bill(written, r.bytes)] })) }),
})
const api = service('api', {
  deps: { blob },
  pools: { vms: instancePool('uc-vms', { instance: vm, min: 1, loadFactor: 1, azs: 1 }) },
  gauges: { bytes: gauge(u.byte) },
  requests: ({ deps, pools }) => ({
    get: request({}, () => ({ bill: [bill(reqs, q(1, u.req))], use: [pools.vms.cpu(q(100, cpuS))] })),
    put: request({ size: u.byte }, (r) => ({
      bill: [bill(reqs, q(1, u.req))],
      calls: [deps.blob.put({ bytes: r.size })],
    })),
  }),
  gaugeMap: (g, { deps }) => [deps.blob.gauges.bytes(g.bytes)],
})
const sc = scenario({
  name: 'uc',
  root: api,
  // the workload's rates don't matter to unitCosts, only which requests have a load and their attributes
  workload: workload(api, {
    requests: { get: { rate: rps(123), attrs: {} }, put: { rate: rps(7), attrs: { size: q(1, u.MB) } } },
    gauges: { bytes: q(1000, u.GB) },
  }),
  pricing: list,
})

describe('unitCosts', () => {
  const at1 = unitCosts(sc, { rate: 1 })
  const at100 = unitCosts(sc, { rate: 100 })
  const get1 = at1.results.find((x) => x.request === 'get')!
  const get100 = at100.results.find((x) => x.request === 'get')!

  it('evaluates every loaded request type alone', () => {
    expect(at1.results.map((x) => x.request)).toEqual(['get', 'put'])
    expect(at1.runs.map((x) => x.scenario)).toEqual(['uc:get', 'uc:put'])
    expect(get1).toMatchObject({ rate: 1, requestsPerMonth: M })
  })

  it('hand-computes the all-in cost including the minimum-size tax', () => {
    // at 1 req/s: requests $2.628; CPU 100 millicore = 0.1 instance busy → 0.1 × 730 × $3.60 = $262.80 used,
    // the other 0.9 of the min-1 instance ($2365.20) idle; total $2630.628
    expect(get1.used).toBeCloseTo(2.628 + 262.8, 6)
    expect(get1.idle).toBeCloseTo(2365.2, 6)
    expect(get1.fixed).toBe(0)
    expect(get1.total).toBeCloseTo(2630.628, 6)
    // per million: used $1 + $100 = $101; all-in $2630.628 / 2.628 = $1001
    expect(get1.perMillion.used).toBeCloseTo(101, 6)
    expect(get1.perMillion.allIn).toBeCloseTo(1001, 6)
    // ceil(0.1) = 1 = min: the dimension, not min, is reported as binding
    expect(get1.pools).toEqual([{ name: 'uc-vms', count: 1, binding: 'cpu' }])
  })

  it('is linear in the rate for request-driven cost; the idle tax shrinks as the pool fills', () => {
    // at 100 req/s: 10,000 millicore → 10 instances, fully used; per-million used cost is unchanged
    expect(get100.perMillion.used).toBeCloseTo(get1.perMillion.used, 6)
    expect(get100.used).toBeCloseTo(100 * get1.used, 4)
    expect(get100.idle).toBeCloseTo(0, 6)
    expect(get100.perMillion.allIn).toBeCloseTo(101, 6)
    expect(get100.pools).toEqual([{ name: 'uc-vms', count: 10, binding: 'cpu' }])
  })

  it('breaks the request-driven cost down by the request’s direct children', () => {
    const put = at1.results.find((x) => x.request === 'put')!
    // put: blob call M × 1 MB = 2628 GB × $1 = $2628; own request dimension $2.628
    expect(put.breakdown).toEqual([
      { name: 'blob', kind: 'offering', cost: expect.closeTo(2628, 6) },
      { name: 't.uc.req', kind: 'dimension', cost: expect.closeTo(2.628, 9) },
    ])
    expect(put.perMillion.used).toBeCloseTo(1001, 6)
    expect(get1.breakdown.map((b) => [b.name, b.kind])).toEqual([
      ['uc-vms', 'pool'],
      ['t.uc.req', 'dimension'],
    ])
  })

  it('leaves gauges out by default and includes them on request', () => {
    expect(at1.runs[0]!.dimensions.map((d) => d.id)).not.toContain('t.uc.stored')
    const withGauges = unitCosts(sc, { rate: 1, requests: ['get'], includeGauges: true }).results[0]!
    // + 1000 GB-month × $0.10 = $100 of used cost
    expect(withGauges.used).toBeCloseTo(get1.used + 100, 6)
    expect(withGauges.total).toBeCloseTo(get1.total + 100, 6)
    expect(withGauges.perMillion.used).toBeCloseTo(101 + 100 / 2.628, 6)
    // the request's own breakdown is unaffected
    expect(withGauges.breakdown).toEqual(get1.breakdown)
  })

  it('evaluates a subset and rejects request types without a load', () => {
    expect(unitCosts(sc, { rate: 1, requests: ['put'] }).results.map((x) => x.request)).toEqual(['put'])
    const noPut = withWorkload(sc, workload(api, { requests: { get: { rate: rps(1), attrs: {} } } }))
    expect(() => unitCosts(noPut, { rate: 1, requests: ['put'] })).toThrow(/no load for 'put'/)
  })

  it('reports the whole idle pool when the rate is 0', () => {
    const zero = unitCosts(sc, { rate: 0, requests: ['get'] }).results[0]!
    expect(zero.used).toBe(0)
    expect(zero.idle).toBeCloseTo(H * 3.6, 6)
  })
})
