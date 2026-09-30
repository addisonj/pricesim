import { describe, expect, it } from 'vitest'
import scenario from '../examples/orders-platform.ts'
import { capacity, evaluate } from '../src/index.ts'

describe('capacity', () => {
  const base = evaluate(scenario)
  const peakCores = base.pools.find((p) => p.name === 'orders-api')!.resources.cpu!.peak / 1000

  it('finds the factor at which a fixed pod count runs out (ceil boundary)', () => {
    // 10 pods × 1 core × 0.6 target utilization sustain 6 cores at peak
    const r = capacity(scenario, { fix: { 'orders-api': 10 } })
    expect(r.factor).toBeCloseTo(6 / peakCores, 3)
    expect(r.binding).toEqual({ pool: 'orders-api', resource: 'cpu' })
    expect(r.result.pools.find((p) => p.name === 'orders-api')!.count).toBeLessThanOrEqual(10)
  })

  it('scales only the requested subset', () => {
    const all = capacity(scenario, { fix: { 'orders-api': 10 } })
    const onlyGets = capacity(scenario, { fix: { 'orders-api': 10 }, scale: ['getOrder'] })
    expect(Object.keys(onlyGets.rates)).toEqual(['getOrder'])
    expect(onlyGets.factor).toBeGreaterThan(all.factor)
  })

  it('validates inputs', () => {
    expect(() => capacity(scenario, { fix: { nope: 3 } })).toThrow(/no pool 'nope'/)
    expect(() => capacity(scenario, { fix: { 'orders-api': 2 } })).toThrow(/below its minimum of 3/)
    expect(() => capacity(scenario, { fix: { 'orders-api': 10 }, scale: ['nope'] })).toThrow(/no request 'nope'/)
  })
})
