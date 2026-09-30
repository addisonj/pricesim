// Time: rate series, integration over steps, and normalization of non-month periods to a billing month.
// Results are always per 730-hour month: usage over a period of P hours is scaled by 730 / P.
import { describe, expect, it } from 'vitest'
import {
  bill,
  dimension,
  evaluate,
  fixedCharge,
  gauge,
  instancePool,
  q,
  request,
  scenario,
  series,
  service,
  tiered,
  u,
  workload,
  type Series,
} from '../../src/index.ts'
import { dimOf, instanceType, list, M, perSecond, poolOf, requestDim, rps, storageDim, cpuS } from './fixtures.ts'

// one request = 1 billed request ($1 per million) + 100 millicore·s on a 1-vCPU instance pool (loadFactor 1),
// so the pool needs ceil(peak rate / 10) instances
const reqs = requestDim('t.time.req')
const vm = instanceType('time-vm') // 1000 millicore, $1/h
const api = service('api', {
  pools: { vms: instancePool('time-vms', { instance: vm, min: 0, loadFactor: 1, azs: 1 }) },
  requests: ({ pools }) => ({
    hit: request({}, () => ({ bill: [bill(reqs, q(1, u.req))], use: [pools.vms.cpu(q(100, cpuS))] })),
  }),
})
const run = (rate: Series<{ req: 1; s: -1 }>, periodHours: number, stepHours = 1) => {
  const w = workload(api, {
    period: q(periodHours, u.hour),
    step: q(stepHours, u.hour),
    requests: { hit: { rate, attrs: {} } },
  })
  return evaluate(scenario({ name: 'time', root: api, workload: w, pricing: list }))
}

describe('rate series', () => {
  it('constant: rate × period, reported per month', () => {
    // 10 req/s over 24 h = 864,000 requests; × 730/24 → 26,280,000 = 10 M per month
    const r = run(rps(10), 24)
    expect(dimOf(r, 't.time.req').usage).toBeCloseTo(10 * M, 3)
    expect(r.period).toEqual({ hours: 24, steps: 24 })
    // peak = mean = 10 req/s → 1000 millicore → 1 instance
    expect(poolOf(r, 'time-vms')).toMatchObject({ count: 1, binding: 'cpu' })
  })

  it('diurnal: whole days integrate to the mean; the pool is sized for the peak', () => {
    // mean 10, peak/mean 2, peak at 12:30 (an hourly midpoint, so a step samples the exact peak of 20)
    // Σ over 24 hourly midpoints of cos(...) = 0 → usage = mean × 24 h → 10 M per month, same as constant
    const r = run(series.diurnal({ mean: q(10, perSecond), peakToMean: 2, peakHour: 12.5 }), 24)
    expect(dimOf(r, 't.time.req').usage).toBeCloseTo(10 * M, 3)
    // peak 20 req/s × 100 millicore·s = 2000 millicore → 2 instances
    const p = poolOf(r, 'time-vms')
    expect(p).toMatchObject({ count: 2, binding: 'cpu' })
    expect(p.resources.cpu!.peak).toBeCloseTo(2000, 9)
    expect(p.resources.cpu!.mean).toBeCloseTo(1000, 9)
  })

  it('fromArray: one value per series step; the pool is sized for the largest', () => {
    // [5, 10, 20, 5] req/s for an hour each: (40 req/s·h) × 3600 = 144,000 requests in 4 h
    // × 730/4 → 26,280,000 = 10 M per month (mean 10 req/s)
    const r = run(
      series.fromArray(
        [5, 10, 20, 5].map((v) => q(v, perSecond)),
        3600,
      ),
      4,
    )
    expect(dimOf(r, 't.time.req').usage).toBeCloseTo(10 * M, 3)
    expect(poolOf(r, 'time-vms')).toMatchObject({ count: 2 }) // peak 20 → 2000 millicore
  })

  it('fromArray: series step independent of the workload step; the last value holds', () => {
    // 2-hour series steps sampled hourly: 5, 5, 15, 15 → mean 10, peak 15
    const coarse = run(series.fromArray([q(5, perSecond), q(15, perSecond)], 7200), 4)
    expect(dimOf(coarse, 't.time.req').usage).toBeCloseTo(10 * M, 3)
    expect(poolOf(coarse, 'time-vms').resources.cpu!.peak).toBeCloseTo(1500, 9)
    // a series shorter than the period holds its last value: 5, 15, 15, 15 → mean 12.5
    const short = run(series.fromArray([q(5, perSecond), q(15, perSecond)], 3600), 4)
    expect(dimOf(short, 't.time.req').usage).toBeCloseTo(12.5 * M, 3)
  })
})

describe('integration over steps', () => {
  // a linear ramp: rate(t) = t / 1 h req/s, so ∫₀^4h rate dt = (4 h)² / 2 / 1 h = 8 req/s·h = 28,800 requests
  const ramp: Series<{ req: 1; s: -1 }> = { describe: 'ramp', at: (t) => t / 3600 }

  it('integrates a linear ramp exactly at any step size', () => {
    // 28,800 requests in 4 h × 730/4 = 5,256,000 per month
    for (const step of [0.25, 1, 2, 4]) {
      const r = run(ramp, 4, step)
      expect(dimOf(r, 't.time.req').usage).toBeCloseTo(5_256_000, 3)
      expect(r.period).toEqual({ hours: 4, steps: 4 / step })
    }
  })

  it('rounds the step count when the step does not divide the period', () => {
    // 4 h / 1.5 h → 3 steps of 4/3 h; a constant rate integrates the same
    const r = run(rps(10), 4, 1.5)
    expect(r.period).toEqual({ hours: 4, steps: 3 })
    expect(dimOf(r, 't.time.req').usage).toBeCloseTo(10 * M, 3)
  })

  it('rejects a step longer than the period', () => {
    expect(() => workload(api, { period: q(1, u.hour), step: q(2, u.hour), requests: {} })).toThrow(/step/)
  })

  // BUG (src/eval/usage.ts): pool sizing takes Math.max(...demand) over the per-step Float64Array, which
  // overflows the call stack beyond ~120k steps (a month at 10 s steps = 262,800 steps).
  //   expected: evaluates like any other step size (10 req/s constant → 10 M requests, 1 instance)
  //   actual:   RangeError: Maximum call stack size exceeded
  it('handles fine-grained steps (a month at 10-second steps)', () => {
    const r = run(rps(10), 730, 10 / 3600)
    expect(r.period.steps).toBe(262_800)
    expect(dimOf(r, 't.time.req').usage).toBeCloseTo(10 * M, 0)
    expect(poolOf(r, 'time-vms').count).toBe(1)
  })
})

describe('periods other than one month', () => {
  // 15 days = 360 h; everything is scaled to a 730-hour month *before* tiers are applied
  const tieredReqs = dimension(
    't.period.req',
    u.req,
    tiered([
      { upTo: 1e6, rate: 2e-6 },
      { upTo: null, rate: 1e-6 },
    ]),
  )
  const stored = storageDim('t.period.stored') // $0.10 per GB-month
  const lbHours = dimension('t.period.lb', u.hour, 0.5)
  const vm15 = instanceType('period-vm') // $1/h
  const svc = service('svc', {
    pools: { vms: instancePool('period-vms', { instance: vm15, min: 2, loadFactor: 1, azs: 1 }) },
    gauges: { bytes: gauge(u.byte, { billAs: stored }) },
    fixed: [fixedCharge(lbHours, 2)],
    requests: () => ({ hit: request({}, () => ({ bill: [bill(tieredReqs, q(1, u.req))] })) }),
  })
  const w = workload(svc, {
    period: q(15, u.day),
    requests: { hit: { rate: rps(1), attrs: {} } },
    gauges: { bytes: q(1000, u.GB) },
  })
  const r = evaluate(scenario({ name: '15d', root: svc, workload: w, pricing: list }))

  it('reports the period', () => {
    expect(r.period).toEqual({ hours: 360, steps: 360 })
  })

  it('normalizes usage to a month before applying tiers', () => {
    // 1 req/s × 1,296,000 s = 1,296,000 requests in 15 days → × 730/360 = 2,628,000 per month
    // tiers on the monthly figure: 1,000,000 × $2/M + 1,628,000 × $1/M = $3.628
    // (tiering the 15-day figure would give 2 + 0.296 = $2.296, or $4.656 after scaling)
    const d = dimOf(r, 't.period.req')
    expect(d.usage).toBeCloseTo(2_628_000, 3)
    expect(d.listCost).toBeCloseTo(3.628, 9)
    expect(d.cost).toBeCloseTo(3.628, 9)
  })

  it('bills gauges, pools and fixed charges per month', () => {
    // 1000 GB held → 1000 GB-month → $100
    expect(dimOf(r, 't.period.stored')).toMatchObject({ usage: expect.closeTo(1000, 9), cost: expect.closeTo(100, 9) })
    // 2 instances (min) → 2 × 730 instance-hours → $1460
    expect(dimOf(r, 't.vm.period-vm.hours')).toMatchObject({ usage: expect.closeTo(1460, 9) })
    // 2 load balancers × 730 h × $0.50 = $730
    expect(dimOf(r, 't.period.lb')).toMatchObject({ usage: expect.closeTo(1460, 9), cost: expect.closeTo(730, 9) })
    expect(r.fixed).toBeCloseTo(730, 9)
    expect(r.total).toBeCloseTo(3.628 + 100 + 1460 + 730, 9)
  })
})
