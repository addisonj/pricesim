// Pricing phase (DESIGN.md §8.1): usage is pooled per billing dimension, the schedule is applied to the
// pooled total, then region multiplier, family discount and negotiated discount; the effective rate is
// allocated back to each consumer in proportion to its usage.
import { describe, expect, it } from 'vitest'
import {
  bill,
  dimension,
  evaluate,
  freeTier,
  offering,
  pricing,
  q,
  request,
  scenario,
  service,
  tiered,
  u,
  workload,
  type BillingDimension,
  type PricingContext,
} from '../../src/index.ts'
import { dimOf, list, M, nodeAt, rps } from './fixtures.ts'

/** Root with two request types, each calling its own offering; both offerings bill `dim` once per call. */
const twoConsumers = (dim: BillingDimension<{ req: 1 }>, ctx: PricingContext = list) => {
  const x = offering('x', { requests: () => ({ op: request({}, () => ({ bill: [bill(dim, q(1, u.req))] })) }) })
  const y = offering('y', { requests: () => ({ op: request({}, () => ({ bill: [bill(dim, q(1, u.req))] })) }) })
  const root = service('root', {
    deps: { x, y },
    requests: ({ deps }) => ({
      viaX: request({}, () => ({ calls: [deps.x.op({})] })),
      viaY: request({}, () => ({ calls: [deps.y.op({})] })),
    }),
  })
  // x: 1 req/s → M = 2,628,000 req; y: 3 req/s → 3M = 7,884,000 req; pooled 4M = 10,512,000 req
  const w = workload(root, {
    requests: { viaX: { rate: rps(1), attrs: {} }, viaY: { rate: rps(3), attrs: {} } },
  })
  const r = evaluate(scenario({ name: 'two', root, workload: w, pricing: ctx }))
  return {
    r,
    x: nodeAt(r.tree, ['root', 'viaX', 'x', 'op', dim.id]).cost,
    y: nodeAt(r.tree, ['root', 'viaY', 'y', 'op', dim.id]).cost,
  }
}

describe('pooled schedules', () => {
  it('applies tiers to the pooled usage and allocates the blended rate proportionally', () => {
    // first 1M req at $2/M, the rest at $1/M
    const dim = dimension(
      't.pool.tiered',
      u.req,
      tiered([
        { upTo: 1e6, rate: 2e-6 },
        { upTo: null, rate: 1e-6 },
      ]),
    )
    const { r, x, y } = twoConsumers(dim)
    // pooled 10,512,000 req: 1M × $2/M + 9.512M × $1/M = $11.512
    const d = dimOf(r, 't.pool.tiered')
    expect(d.usage).toBeCloseTo(4 * M, 3)
    expect(d.cost).toBeCloseTo(11.512, 9)
    expect(d.effectiveRate).toBeCloseTo(11.512 / 10_512_000, 15)
    // x has 1/4 of the usage → $2.878 (not the $3.628 it would pay alone); y 3/4 → $8.634
    expect(x).toBeCloseTo(2.878, 9)
    expect(y).toBeCloseTo(8.634, 9)
    expect(x + y).toBeCloseTo(d.cost, 9)
  })

  it('applies a free tier once to the pooled usage', () => {
    const dim = dimension('t.pool.free', u.req, freeTier(1e6, 1e-6))
    const { r, x, y } = twoConsumers(dim)
    // (10,512,000 − 1,000,000) × $1/M = $9.512, split 1 : 3
    expect(dimOf(r, 't.pool.free').cost).toBeCloseTo(9.512, 9)
    expect(x).toBeCloseTo(2.378, 9)
    expect(y).toBeCloseTo(7.134, 9)
  })

  it('charges nothing while pooled usage stays inside the free tier', () => {
    const dim = dimension('t.pool.allfree', u.req, freeTier(1e9, 1e-6))
    const { r, x } = twoConsumers(dim)
    expect(dimOf(r, 't.pool.allfree')).toMatchObject({ cost: 0, effectiveRate: 0 })
    expect(x).toBe(0)
  })
})

describe('pricing context', () => {
  // flat $1 per million requests; pooled 10,512,000 req → list $10.512
  const flat = (family: string) => dimension(`t.ctx.${family}`, u.req, 1e-6, { family })
  const LIST = 10.512

  it('applies the region multiplier to cost but not to listCost', () => {
    const ctx = pricing({ region: 'test-1', regionMultipliers: { 'test-1': 2 } })
    const { r, x } = twoConsumers(flat('t.compute'), ctx)
    const d = dimOf(r, 't.ctx.t.compute')
    expect(d.listCost).toBeCloseTo(LIST, 9)
    expect(d.cost).toBeCloseTo(2 * LIST, 9)
    expect(x).toBeCloseTo(LIST / 2, 9) // 1/4 of $21.024
    expect(r.region).toBe('test-1')
  })

  it('uses the longest matching family prefix, on segment boundaries', () => {
    const ctx = pricing({ familyDiscounts: { t: 0.1, 't.compute': 0.5 } })
    const cost = (family: string) => dimOf(twoConsumers(flat(family), ctx).r, `t.ctx.${family}`).cost
    expect(cost('t.compute')).toBeCloseTo(LIST * 0.5, 9) // exact match
    expect(cost('t.compute.spot')).toBeCloseTo(LIST * 0.5, 9) // longest prefix 't.compute'
    expect(cost('t.storage')).toBeCloseTo(LIST * 0.9, 9) // falls back to 't'
    expect(cost('t.computer')).toBeCloseTo(LIST * 0.9, 9) // 't.compute' is not a prefix of 't.computer'
    expect(cost('tx.other')).toBeCloseTo(LIST, 9) // 't' is not a prefix of 'tx'
  })

  it('applies the negotiated discount after (multiplied with) the family discount and region', () => {
    const ctx = pricing({
      region: 'test-1',
      regionMultipliers: { 'test-1': 2 },
      familyDiscounts: { 't.compute': 0.5 },
      negotiatedDiscount: 0.2,
    })
    const { r, x, y } = twoConsumers(flat('t.compute'), ctx)
    // list × 2 × (1 − 0.5) × (1 − 0.2) = list × 0.8 (additive discounts would give list × 2 × 0.3 = 0.6)
    const d = dimOf(r, 't.ctx.t.compute')
    expect(d.cost).toBeCloseTo(LIST * 0.8, 9)
    expect(d.effectiveRate).toBeCloseTo(0.8e-6, 15)
    expect(x).toBeCloseTo(LIST * 0.2, 9)
    expect(y).toBeCloseTo(LIST * 0.6, 9)
  })

  it('discounts tiered dimensions after the tiers', () => {
    const dim = dimension(
      't.ctx.tiered',
      u.req,
      tiered([
        { upTo: 1e6, rate: 2e-6 },
        { upTo: null, rate: 1e-6 },
      ]),
      { family: 't.compute' },
    )
    const { r } = twoConsumers(dim, pricing({ familyDiscounts: { 't.compute': 0.5 } }))
    expect(dimOf(r, 't.ctx.tiered')).toMatchObject({
      listCost: expect.closeTo(11.512, 9),
      cost: expect.closeTo(5.756, 9),
    })
  })
})

describe('dimension identity', () => {
  it('pools the same dimension object used by several consumers', () => {
    const dim = dimension('t.id.same', u.req, 1e-6)
    expect(twoConsumers(dim).r.dimensions.map((d) => d.id)).toEqual(['t.id.same'])
  })

  it('rejects two different dimension objects that share an id', () => {
    const a = dimension('t.id.dup', u.req, 1e-6)
    const b = dimension('t.id.dup', u.req, 2e-6)
    const x = offering('x', { requests: () => ({ op: request({}, () => ({ bill: [bill(a, q(1, u.req))] })) }) })
    const y = offering('y', { requests: () => ({ op: request({}, () => ({ bill: [bill(b, q(1, u.req))] })) }) })
    const root = service('root', {
      deps: { x, y },
      requests: ({ deps }) => ({ go: request({}, () => ({ calls: [deps.x.op({}), deps.y.op({})] })) }),
    })
    const w = workload(root, { requests: { go: { rate: rps(1), attrs: {} } } })
    expect(() => evaluate(scenario({ name: 'dup', root, workload: w, pricing: list }))).toThrow(
      /two different billing dimensions share id 't.id.dup'/,
    )
  })
})

describe('dimension report', () => {
  it('lists every dimension once, sorted by cost, with usage in its own unit', () => {
    const cheap = dimension('t.rep.cheap', u.req, 1e-6)
    const dear = dimension('t.rep.dear', u.GB, 1)
    const svc = offering('svc', {
      requests: () => ({
        op: request({}, () => ({ bill: [bill(cheap, q(1, u.req)), bill(dear, q(1, u.MB))] })),
      }),
    })
    const w = workload(svc, { requests: { op: { rate: rps(1), attrs: {} } } })
    const r = evaluate(scenario({ name: 'rep', root: svc, workload: w, pricing: list }))
    // cheap: M req × $1/M = $2.628; dear: M × 1 MB = 2628 GB × $1 = $2628
    expect(r.dimensions.map((d) => d.id)).toEqual(['t.rep.dear', 't.rep.cheap'])
    expect(r.dimensions[0]).toMatchObject({
      family: 't.rep',
      usage: expect.closeTo(2628, 9),
      unit: 'GB',
      cost: expect.closeTo(2628, 9),
      effectiveRate: expect.closeTo(1, 12),
    })
    expect(r.dimensions[1]).toMatchObject({ usage: expect.closeTo(M, 3), unit: 'req', cost: expect.closeTo(2.628, 9) })
    expect(r.reportUnit).toBe('USD/month')
  })
})
