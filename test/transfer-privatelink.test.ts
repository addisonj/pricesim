// Hand-computed bills for inter-region transfer, same-region public-IP transfer and PrivateLink (us-east-1).
import { describe, expect, it } from 'vitest'
import {
  directConnect,
  interRegion,
  interRegionTo,
  interRegionTransfer,
  networkLoadBalancer,
  privateLinkEndpoint,
  sameRegionPublicTransfer,
} from '../src/catalog/aws/index.ts'
import { evaluate, pricing, q, request, scenario, series, service, u, workload } from '../src/index.ts'

const HOURS = 730
const SECONDS = HOURS * 3600
/** a rate that sends `n` requests over the one-month period */
const perMonth = (n: number) => series.constant(q(n / SECONDS, u.req.div(u.s)))

type Result = ReturnType<typeof evaluate>
const dimCost = (r: Result, id: string) => r.dimensions.find((d) => d.id === id)?.cost ?? 0

describe('inter-region transfer', () => {
  const sendGB = (node: ReturnType<typeof interRegionTransfer>, gb: number) =>
    evaluate(
      scenario({
        name: 'xr',
        root: node,
        workload: workload(node, { requests: { send: { rate: perMonth(gb), attrs: { bytes: q(1, u.GB) } } } }),
        pricing: pricing(),
      }),
    )

  it('bills 1 GB at the common $0.02/GB', () => {
    const r = sendGB(interRegionTransfer('dr'), 1)
    expect(dimCost(r, 'aws.transfer.inter-region')).toBeCloseTo(0.02, 9)
    expect(r.total).toBeCloseTo(0.02, 9)
  })

  it('bills us-east-2 at $0.01/GB on its own dimension', () => {
    const r = sendGB(interRegionTransfer('ohio', { to: 'us-east-2' }), 1000)
    expect(dimCost(r, 'aws.transfer.inter-region.us-east-2')).toBeCloseTo(10, 6)
    expect(r.total).toBeCloseTo(10, 6)
  })

  it('maps destinations at the common rate, and unknown ones, to the shared dimension', () => {
    expect(interRegionTo('us-west-2')).toBe(interRegion)
    expect(interRegionTo('xx-nowhere-1')).toBe(interRegion)
    expect(interRegionTo('us-east-2')).toBe(interRegionTo('us-east-2'))
    expect(interRegionTo('ap-southeast-7').id).toBe('aws.transfer.inter-region.ap-southeast-7')
  })

  it('has no volume tiers', () => {
    expect(sendGB(interRegionTransfer('bulk'), 500_000).total).toBeCloseTo(500_000 * 0.02, 4)
  })
})

describe('same-region transfer over public IPs', () => {
  it('bills $0.01/GB in each direction', () => {
    const pub = sameRegionPublicTransfer()
    const w = workload(pub, { requests: { send: { rate: perMonth(100), attrs: { bytes: q(1, u.GB) } } } })
    const r = evaluate(scenario({ name: 'eip', root: pub, workload: w, pricing: pricing() }))
    expect(dimCost(r, 'aws.transfer.same-region-public')).toBeCloseTo(100 * 2 * 0.01, 9)
    expect(r.total).toBeCloseTo(2, 9)
  })
})

describe('PrivateLink interface endpoint', () => {
  const run = (azs: number, gb: number) => {
    const ep = privateLinkEndpoint('api', { azs })
    const w = workload(ep, {
      requests: gb > 0 ? { process: { rate: perMonth(gb), attrs: { bytes: q(1, u.GB) } } } : {},
    })
    return evaluate(scenario({ name: 'pl', root: ep, workload: w, pricing: pricing() }))
  }

  it('charges an idle endpoint per AZ-hour', () => {
    const r = run(3, 0)
    expect(r.total).toBeCloseTo(3 * HOURS * 0.01, 9) // $21.90
    expect(r.fixed).toBeCloseTo(r.total, 9)
  })

  it('bills 1 TB processed at $0.01/GB on top of the hours', () => {
    const ep = privateLinkEndpoint('api', { azs: 2 })
    const w = workload(ep, { requests: { process: { rate: perMonth(1), attrs: { bytes: q(1, u.TB) } } } })
    const r = evaluate(scenario({ name: 'pl', root: ep, workload: w, pricing: pricing() }))
    expect(dimCost(r, 'aws.vpc.endpoint.processed')).toBeCloseTo(1000 * 0.01, 6)
    expect(r.total).toBeCloseTo(2 * HOURS * 0.01 + 10, 6)
  })

  it('applies the volume tiers (1 PB = 1,048,576 GB)', () => {
    const PB = 1_048_576
    // 2 PB: 1 PB at $0.01, 1 PB at $0.006
    expect(dimCost(run(1, 2 * PB), 'aws.vpc.endpoint.processed')).toBeCloseTo(PB * 0.01 + PB * 0.006, 2)
    // 6 PB: 1 PB at $0.01, 4 PB at $0.006, 1 PB at $0.004
    const six = PB * 0.01 + 4 * PB * 0.006 + PB * 0.004
    expect(dimCost(run(1, 6 * PB), 'aws.vpc.endpoint.processed')).toBeCloseTo(six, 2)
  })

  it('pools the tiers across endpoints', () => {
    const PB = 1_048_576
    const a = privateLinkEndpoint('a', { azs: 1 })
    const b = privateLinkEndpoint('b', { azs: 1 })
    const api = service('api', {
      deps: { a, b },
      requests: ({ deps }) => ({
        call: request({ bytes: u.byte }, (r) => ({
          calls: [deps.a.process({ bytes: r.bytes }), deps.b.process({ bytes: r.bytes })],
        })),
      }),
    })
    const w = workload(api, { requests: { call: { rate: perMonth(PB), attrs: { bytes: q(1, u.GB) } } } })
    const r = evaluate(scenario({ name: 'pooled', root: api, workload: w, pricing: pricing() }))
    // 2 PB in one pool, plus two single-AZ endpoints
    expect(r.total).toBeCloseTo(PB * 0.01 + PB * 0.006 + 2 * HOURS * 0.01, 2)
  })

  it('adds nothing on the provider side beyond its NLB', () => {
    const nlb = networkLoadBalancer('svc')
    const ep = privateLinkEndpoint('svc', { azs: 2 })
    const both = service('consumer', { deps: { nlb, ep }, requests: () => ({}) })
    const r = evaluate(
      scenario({ name: 'provider', root: both, workload: workload(both, { requests: {} }), pricing: pricing() }),
    )
    expect(r.total).toBeCloseTo(HOURS * 0.0225 + 2 * HOURS * 0.01, 9)
  })

  it('rejects a non-positive AZ count', () => {
    expect(() => privateLinkEndpoint('bad', { azs: 0 })).toThrow(/azs/)
  })
})

describe('Direct Connect', () => {
  const run = (dx: ReturnType<typeof directConnect>, outGB: number, inGB: number) =>
    evaluate(
      scenario({
        name: 'dx',
        root: dx,
        workload: workload(dx, {
          requests: {
            out: { rate: perMonth(outGB), attrs: { bytes: q(1, u.GB) } },
            in: { rate: perMonth(inGB), attrs: { bytes: q(1, u.GB) } },
          },
        }),
        pricing: pricing(),
      }),
    )

  it('bills port-hours per connection and $0.02/GB out; data in is free', () => {
    const r = run(directConnect('dc', { dedicated: '10G', count: 4 }), 1000, 5000)
    expect(dimCost(r, 'aws.directconnect.dedicated.10G')).toBeCloseTo(4 * 2.25 * HOURS, 6)
    expect(dimCost(r, 'aws.directconnect.transfer-out')).toBeCloseTo(20, 6)
    expect(r.total).toBeCloseTo(4 * 2.25 * HOURS + 20, 6)
  })

  it('prices hosted ports on their own dimensions', () => {
    const r = run(directConnect('h', { hosted: '1G' }), 0, 0)
    expect(dimCost(r, 'aws.directconnect.hosted.1G')).toBeCloseTo(0.33 * HOURS, 6)
  })

  it('flat rate: a 10G Tier-1 pair costs one port-rate ($10.96/h) and includes transfer out', () => {
    const r = run(directConnect('fr', { flatRate: { speed: '10G', tier: 1 } }), 500_000, 1_000_000)
    expect(dimCost(r, 'aws.directconnect.flat-rate.10G-pair.tier1')).toBeCloseTo(10.96 * HOURS, 6)
    expect(r.dimensions.find((d) => d.id === 'aws.directconnect.flat-rate.transfer-out')!.usage).toBeCloseTo(500_000, 3)
    expect(dimCost(r, 'aws.directconnect.transfer-out')).toBe(0)
    expect(r.total).toBeCloseTo(10.96 * HOURS, 6)
    const two = run(directConnect('fr2', { flatRate: { speed: '100G', tier: 3 }, count: 2 }), 0, 0)
    expect(two.total).toBeCloseTo(2 * 219.18 * HOURS, 6)
  })

  it('rejects a non-positive count', () => {
    expect(() => directConnect('x', { dedicated: '1G', count: 0 })).toThrow(/count/)
  })
})
