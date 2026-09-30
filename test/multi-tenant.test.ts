import { describe, expect, it } from 'vitest'
import { events, shared, tenants, TOTAL_PUBLISH } from '../examples/multi-tenant.ts'
import {
  evaluate,
  meanRateBindings,
  pricing,
  q,
  scenario,
  series,
  simulateTenants,
  u,
  withWorkload,
  workload,
  zipfTenants,
} from '../src/index.ts'

describe('tenant simulation', () => {
  const make = ({ share }: { share: number }) =>
    workload(events, {
      requests: { fetch: { rate: series.constant(q(1000 * share, u.req.div(u.s))), attrs: { bytes: q(1, u.KB) } } },
    })

  it('zipfTenants: shares follow 1/rank and sum to 1', () => {
    const ts = zipfTenants({ count: 10, make })
    const rates = ts.map((t) => meanRateBindings(t.workload)['rate.fetch']!)
    expect(rates.reduce((a, r) => a + r, 0)).toBeCloseTo(1000, 6)
    expect(rates[0]! / rates[1]!).toBeCloseTo(2, 6)
    expect(ts.map((t) => t.id).slice(0, 2)).toEqual(['tenant-01', 'tenant-02'])
  })

  it('simulateTenants gives each tenant an independent, reproducible stream', () => {
    const draw = () =>
      simulateTenants({ count: 3, seed: 5, make: ({ rng }) => make({ share: rng.next() }) }).map(
        (t) => meanRateBindings(t.workload)['rate.fetch'],
      )
    expect(draw()).toEqual(draw())
    expect(new Set(draw()).size).toBe(3)
  })
})

describe('multi-tenant example', () => {
  const r = evaluate(shared)

  it('carries the whole Zipf population and attributes every dollar to a tenant', () => {
    expect(r.tenants).toHaveLength(200)
    expect(r.tenants!.reduce((a, t) => a + t.total, 0)).toBeCloseTo(r.total, 6)
    const publish = tenants.reduce((a, t) => a + meanRateBindings(t.workload)['rate.publish']!, 0)
    // diurnal series over 730 h (not a whole number of days) average ~0.5% below their nominal mean
    expect(Math.abs(publish / TOTAL_PUBLISH - 1)).toBeLessThan(0.01)
  })

  it('is heavy-tailed: the top 10% of tenants drive most of the used cost', () => {
    const used = [...r.tenants!].sort((a, b) => b.used - a.used).map((t) => t.used)
    const top = used.slice(0, 20).reduce((a, x) => a + x, 0)
    expect(top / r.used).toBeGreaterThan(0.5)
  })

  it('sharing beats dedicated deployments, mostly by removing the minimum-size tax', () => {
    const subset = tenants.slice(0, 20)
    const pooled = evaluate(scenario({ name: 'subset', root: events, tenants: subset, pricing: pricing() }))
    const base = scenario({ name: 'subset', root: events, tenants: subset, pricing: pricing() })
    const dedicated = subset.map((t) => evaluate(withWorkload(base, t.workload, t.id)))
    const dedicatedTotal = dedicated.reduce((a, x) => a + x.total, 0)
    expect(pooled.total).toBeLessThan(dedicatedTotal)
    expect(dedicated.reduce((a, x) => a + x.idle, 0)).toBeGreaterThan(10 * pooled.idle)
  })
})
