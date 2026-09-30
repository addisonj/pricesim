import { describe, expect, it } from 'vitest'
import scenario from '../examples/orders-platform.ts'
import { closedForm, evaluate, peakOf, withWorkload } from '../src/index.ts'

describe('peak definition', () => {
  it('computes max and nearest-rank percentiles', () => {
    const xs = [5, 1, 4, 2, 3, 10, 6, 7, 9, 8]
    expect(peakOf(xs)).toBe(10)
    expect(peakOf(xs, { percentile: 90 })).toBe(9)
    expect(peakOf(xs, { percentile: 50 })).toBe(5)
    expect(() => peakOf(xs, { percentile: 0 })).toThrow()
  })

  it('sizes pools on a percentile when asked (fewer pods than sizing on the max)', () => {
    const p50 = withWorkload(scenario, { ...scenario.workload!, peak: { percentile: 50 } })
    const podsMax = evaluate(scenario).pools.find((p) => p.name === 'orders-api')!.count
    const podsP50 = evaluate(p50).pools.find((p) => p.name === 'orders-api')!.count
    expect(podsP50).toBeLessThan(podsMax)
    // closed form uses the same peak definition
    expect(closedForm(p50).value).toBeCloseTo(evaluate(p50).total, 6)
  })
})
