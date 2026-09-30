import { describe, expect, it } from 'vitest'
import { orders, typical } from '../examples/orders-platform.ts'
import { interAz } from '../src/catalog/aws/index.ts'
import { closedForm, evaluate, pricing, q, scenario, series, u, workload } from '../src/index.ts'

const tenant = (id: string, rate: number) => ({
  id,
  workload: workload(orders, {
    requests: { getOrder: { rate: series.constant(q(rate, u.req.div(u.s))), attrs: { bytes: q(2, u.KB) } } },
  }),
})

describe('multi-tenant scenarios', () => {
  const small = tenant('small', 10)
  const big = tenant('big', 2000)
  const shared = evaluate(
    scenario({ name: 'shared', root: orders, tenants: [small, big], pricing: pricing(), interAz }),
  )
  const alone = (t: ReturnType<typeof tenant>) =>
    evaluate(scenario({ name: t.id, root: orders, workload: t.workload, pricing: pricing(), interAz }))

  it('attributes used cost per tenant under a tenant branch of the tree', () => {
    const ids = shared.tree
      .children!.filter((c) => c.kind === 'tenant')
      .map((c) => c.name)
      .sort()
    expect(ids).toEqual(['big', 'small'])
    const ts = shared.tenants!
    expect(ts.reduce((a, t) => a + t.used, 0)).toBeCloseTo(shared.used, 6)
    expect(ts.reduce((a, t) => a + t.total, 0)).toBeCloseTo(shared.total, 6)
  })

  it('sizes shared capacity on combined demand: sharing is cheaper than running separately', () => {
    expect(shared.total).toBeLessThan(alone(small).total + alone(big).total)
    // the small tenant alone pays the whole minimum-size tax; shared, it pays a used-proportional share
    const smallShared = shared.tenants!.find((t) => t.id === 'small')!
    expect(smallShared.total).toBeLessThan(alone(small).total / 10)
  })

  it('validates tenants', () => {
    expect(() =>
      evaluate(scenario({ name: 'dup', root: orders, tenants: [small, small], pricing: pricing(), interAz })),
    ).toThrow(/duplicate tenant id 'small'/)
    const monthly = scenario({ name: 'x', root: orders, tenants: [small, big], pricing: pricing(), interAz })
    expect(() => closedForm(monthly)).toThrow(/multi-tenant scenarios are not supported yet/)
  })

  it('single-workload scenarios have no tenants section', () => {
    expect(
      evaluate(scenario({ name: 'one', root: orders, workload: typical, pricing: pricing(), interAz })).tenants,
    ).toBeUndefined()
  })
})
