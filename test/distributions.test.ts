import { describe, expect, it } from 'vitest'
import {
  bill,
  ceil,
  closedForm,
  dimension,
  dist,
  evaluate,
  pricing,
  q,
  request,
  rng,
  scenario,
  series,
  service,
  u,
  workload,
  zipfWeights,
} from '../src/index.ts'

describe('seeded randomness', () => {
  it('is reproducible and forks independent streams', () => {
    const a = rng(42)
    const b = rng(42)
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()])
    expect(rng(42).fork('x').next()).not.toBe(rng(42).fork('y').next())
  })

  it('normalizes Zipf weights', () => {
    const w = zipfWeights(4)
    expect(w.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 12)
    expect(w[0]! / w[1]!).toBeCloseTo(2, 12)
  })

  it('distributions have the right means', () => {
    expect(dist.uniform({ min: q(1, u.KB), max: q(3, u.KB) }).mean).toBe(2000)
    expect(
      dist.empirical([
        { value: q(1, u.KB), weight: 3 },
        { value: q(5, u.KB), weight: 1 },
      ]).mean,
    ).toBe(2000)
    const ln = dist.lognormal({ median: q(1, u.KB), p99: q(64, u.KB) })
    const r = rng(7)
    let sum = 0
    for (let i = 0; i < 200_000; i++) sum += ln.sample(r)
    expect(sum / 200_000 / ln.mean).toBeCloseTo(1, 1)
  })
})

describe('distribution-valued attributes', () => {
  // one write unit per started KB: non-linear in the item size
  const wru = dimension('t.wru', u.op, 1e-6)
  const table = service('table', {
    requests: () => ({
      write: request({ bytes: u.byte }, (r) => ({ bill: [bill(wru, ceil(r.bytes.div(q(1, u.KB))).mul(q(1, u.op)))] })),
    }),
  })
  const sizes = dist.empirical([
    { value: q(0.5, u.KB), weight: 1 },
    { value: q(1.5, u.KB), weight: 1 },
  ])
  const run = (seed: number, samples = 400) =>
    evaluate(
      scenario({
        name: 'mc',
        root: table,
        pricing: pricing(),
        workload: workload(table, {
          requests: { write: { rate: series.constant(q(1, u.req.div(u.s))), attrs: { bytes: sizes } } },
          seed,
          samples,
        }),
      }),
    )
  const perRequest = (seed: number, samples?: number) => run(seed, samples).dimensions[0]!.usage / (730 * 3600)

  it('costs the non-linear expression per sample (≈1.5 WRU), not at the mean size (1 WRU)', () => {
    expect(perRequest(1)).toBeGreaterThan(1.4)
    expect(perRequest(1)).toBeLessThan(1.6)
  })

  it('is deterministic for a seed and varies across seeds', () => {
    expect(perRequest(1, 16)).toBe(perRequest(1, 16))
    const values = new Set([1, 2, 3, 4, 5].map((s) => perRequest(s, 16)))
    expect(values.size).toBeGreaterThan(1)
  })

  it('closed forms use the mean and say so', () => {
    const cf = closedForm(
      scenario({
        name: 'mc',
        root: table,
        pricing: pricing(),
        workload: workload(table, {
          requests: { write: { rate: series.constant(q(1, u.req.div(u.s))), attrs: { bytes: sizes } } },
        }),
      }),
    )
    expect(cf.assumptions.join(' ')).toMatch(/replaced by their mean: write\.bytes/)
  })
})
