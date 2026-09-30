// Hand-computed bills for the S3 Express, ELB, NAT gateway and internet egress offerings (us-east-1).
import { describe, expect, it } from 'vitest'
import {
  applicationLoadBalancer,
  internetEgress,
  natGateway,
  networkLoadBalancer,
  placementOf,
  s3ExpressBucket,
} from '../src/catalog/aws/index.ts'
import { evaluate, pricing, q, request, scenario, series, service, u, workload } from '../src/index.ts'

const HOURS = 730
const SECONDS = HOURS * 3600
const perSecond = (n: number) => series.constant(q(n, u.req.div(u.s)))
/** a rate that sends `n` requests over the one-month period */
const perMonth = (n: number) => perSecond(n / SECONDS)

type Result = ReturnType<typeof evaluate>
const dimCost = (r: Result, id: string) => r.dimensions.find((d) => d.id === id)?.cost ?? 0

describe('S3 Express One Zone', () => {
  const bucket = s3ExpressBucket('hot')

  it('is single-AZ', () => {
    expect(placementOf(bucket)).toEqual({ kind: 'singleAz' })
    expect(placementOf(internetEgress())).toBeUndefined()
  })

  it('bills requests, per-GB upload/retrieval on all bytes, and storage', () => {
    const w = workload(bucket, {
      requests: {
        put: { rate: perMonth(1e6), attrs: { bytes: q(1, u.MB) } },
        get: { rate: perMonth(2e6), attrs: { bytes: q(1, u.MB) } },
      },
      gauges: { stored: q(100, u.GB) },
    })
    const r = evaluate(scenario({ name: 's3x', root: bucket, workload: w, pricing: pricing() }))
    expect(dimCost(r, 'aws.s3express.put')).toBeCloseTo(1e6 * 0.00113e-3, 6)
    expect(dimCost(r, 'aws.s3express.upload')).toBeCloseTo(1000 * 0.0032, 6) // 1e6 × 1 MB = 1000 GB
    expect(dimCost(r, 'aws.s3express.get')).toBeCloseTo(2e6 * 0.00003e-3, 6)
    expect(dimCost(r, 'aws.s3express.retrieval')).toBeCloseTo(2000 * 0.0006, 6)
    expect(dimCost(r, 'aws.s3express.storage')).toBeCloseTo(100 * 0.11, 6)
    expect(r.total).toBeCloseTo(1.13 + 3.2 + 0.06 + 1.2 + 11, 6)
  })

  it('bills one PUT per part for multipart uploads', () => {
    const w = workload(bucket, { requests: { put: { rate: perMonth(1000), attrs: { bytes: q(40, u.MiB) } } } })
    const r = evaluate(scenario({ name: 's3x-mpu', root: bucket, workload: w, pricing: pricing() }))
    expect(dimCost(r, 'aws.s3express.put')).toBeCloseTo(3 * 1000 * 0.00113e-3, 9) // ceil(40 / 16) parts
  })
})

describe('Elastic Load Balancing', () => {
  it('charges an idle ALB for its hours only', () => {
    const alb = applicationLoadBalancer('web')
    const r = evaluate(
      scenario({ name: 'alb', root: alb, workload: workload(alb, { requests: {} }), pricing: pricing() }),
    )
    expect(r.total).toBeCloseTo(HOURS * 0.0225, 6)
    expect(r.fixed).toBeCloseTo(r.total, 6)
  })

  it('bills ALB LCU-hours from processed bytes (1 GB per LCU-hour)', () => {
    const alb = applicationLoadBalancer('web')
    const w = workload(alb, { requests: { forward: { rate: perMonth(1e6), attrs: { bytes: q(50, u.KB) } } } })
    const r = evaluate(scenario({ name: 'alb', root: alb, workload: w, pricing: pricing() }))
    const gb = (1e6 * 50e3) / 1e9 // 50 GB
    expect(dimCost(r, 'aws.elb.alb.lcu-hours')).toBeCloseTo(gb * 0.008, 6)
    expect(r.total).toBeCloseTo(HOURS * 0.0225 + gb * 0.008, 6)
  })

  it('bills NLBs per load balancer-hour and NLCU-hour', () => {
    const nlb = networkLoadBalancer('ingest', { count: 2 })
    const w = workload(nlb, { requests: { forward: { rate: perMonth(1000), attrs: { bytes: q(1, u.GB) } } } })
    const r = evaluate(scenario({ name: 'nlb', root: nlb, workload: w, pricing: pricing() }))
    expect(dimCost(r, 'aws.elb.nlb.hours')).toBeCloseTo(2 * HOURS * 0.0225, 6)
    expect(dimCost(r, 'aws.elb.nlb.lcu-hours')).toBeCloseTo(1000 * 0.006, 6)
  })
})

describe('NAT gateway', () => {
  it('bills hours per gateway and GB processed', () => {
    const nat = natGateway('egress', { count: 3 })
    const w = workload(nat, { requests: { process: { rate: perMonth(500), attrs: { bytes: q(1, u.GB) } } } })
    const r = evaluate(scenario({ name: 'nat', root: nat, workload: w, pricing: pricing() }))
    expect(dimCost(r, 'aws.vpc.natgateway.hours')).toBeCloseTo(3 * HOURS * 0.045, 6)
    expect(dimCost(r, 'aws.vpc.natgateway.processed')).toBeCloseTo(500 * 0.045, 6)
    expect(r.total).toBeCloseTo(3 * HOURS * 0.045 + 500 * 0.045, 6)
  })
})

describe('internet egress', () => {
  const internet = internetEgress()
  const monthOf = (gb: number) => {
    const w = workload(internet, { requests: { send: { rate: perMonth(gb), attrs: { bytes: q(1, u.GB) } } } })
    return evaluate(scenario({ name: 'egress', root: internet, workload: w, pricing: pricing() }))
  }

  it('is free for the first 100 GB/month', () => {
    expect(monthOf(80).total).toBeCloseTo(0, 9)
    expect(monthOf(150).total).toBeCloseTo(50 * 0.09, 6)
  })

  it('applies the volume tiers after the free tier (1 TB = 1024 GB)', () => {
    // 60,000 GB: 100 free, 10,240 at $0.09, 40,960 at $0.085, the remaining 8,700 at $0.07
    expect(monthOf(60_000).total).toBeCloseTo(10_240 * 0.09 + 40_960 * 0.085 + 8_700 * 0.07, 6)
    // 200,000 GB: past the last bound (153,600 GB) at $0.05
    const top = 10_240 * 0.09 + 40_960 * 0.085 + 102_400 * 0.07 + (200_000 - 100 - 153_600) * 0.05
    expect(monthOf(200_000).total).toBeCloseTo(top, 6)
  })

  it('pools tiers across every service that sends to the internet', () => {
    const a = internetEgress('a')
    const b = internetEgress('b')
    const api = service('api', {
      deps: { a, b },
      requests: ({ deps }) => ({
        respond: request({ bytes: u.byte }, (r) => ({
          calls: [deps.a.send({ bytes: r.bytes }), deps.b.send({ bytes: r.bytes })],
        })),
      }),
    })
    const w = workload(api, { requests: { respond: { rate: perMonth(10_000), attrs: { bytes: q(1, u.GB) } } } })
    const r = evaluate(scenario({ name: 'pooled', root: api, workload: w, pricing: pricing() }))
    // 20,000 GB in one pool: 100 free, 10,240 at $0.09, 9,660 at $0.085
    expect(r.total).toBeCloseTo(10_240 * 0.09 + 9_660 * 0.085, 6)
  })
})
