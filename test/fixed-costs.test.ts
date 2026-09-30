// Minimum-size capacity and fixed charges are billed whether or not anything uses them.
import { describe, expect, it } from 'vitest'
import { orders } from '../examples/orders-platform.ts'
import { interAz } from '../src/catalog/aws/index.ts'
import {
  dimension,
  evaluate,
  fixedCharge,
  offering,
  pricing,
  q,
  request,
  scenario,
  series,
  service,
  u,
  workload,
} from '../src/index.ts'

const HOURS = 730

describe('minimum-size capacity', () => {
  // getOrder never touches the ledger service or its Aurora cluster
  const onlyGets = workload(orders, {
    requests: {
      getOrder: { rate: series.constant(q(1000, u.req.div(u.s))), attrs: { bytes: q(2, u.KB) } },
    },
  })
  const r = evaluate(scenario({ name: 'gets', root: orders, workload: onlyGets, pricing: pricing(), interAz }))
  const pool = (name: string) => r.pools.find((p) => p.name === name)

  it('provisions unused pools at their minimum', () => {
    expect(pool('aurora:ledger')).toMatchObject({ count: 2, binding: 'min' })
    expect(pool('ledger')).toMatchObject({ count: 2, binding: 'min' })
    expect(pool('inventory')).toMatchObject({ count: 2, binding: 'min' })
    expect(pool('shared-nodes')).toMatchObject({ count: 3 })
  })

  it('charges the whole unused Aurora cluster as idle headroom', () => {
    const aurora = r.dimensions.find((d) => d.id === 'aws.aurora-postgresql.db.r7g.large.hours')!
    expect(aurora.cost).toBeCloseTo(2 * HOURS * 0.276, 6)
    const idle = r.tree.children!.find((c) => c.name === 'idle')!.children!.find((c) => c.name === 'aurora:ledger')!
    expect(idle.cost).toBeCloseTo(2 * HOURS * 0.276, 6)
  })

  it('keeps used + idle + fixed = total', () => {
    expect(r.used + r.idle + r.fixed).toBeCloseTo(r.total, 6)
    expect(r.fixed).toBe(0)
  })
})

describe('fixed charges', () => {
  const lbHours = dimension('test.lb.hours', u.hour, 0.0225)
  const lb = offering('lb', {
    fixed: [fixedCharge(lbHours, 2)],
    requests: () => ({ forward: request({}, () => ({})) }),
  })
  const api = service('api', {
    deps: { lb },
    requests: ({ deps }) => ({ get: request({}, () => ({ calls: [deps.lb.forward({})] })) }),
  })
  const idleWorkload = workload(api, { requests: {} })
  const r = evaluate(scenario({ name: 'lb', root: api, workload: idleWorkload, pricing: pricing() }))

  it('accrues for the whole period with no traffic', () => {
    expect(r.total).toBeCloseTo(2 * HOURS * 0.0225, 6)
    expect(r.fixed).toBeCloseTo(r.total, 6)
    const fixed = r.tree.children!.find((c) => c.name === 'fixed')!
    expect(fixed.children![0]).toMatchObject({ name: 'lb', kind: 'offering' })
  })

  it('rejects dimensions that are not billed per unit of time', () => {
    expect(() => fixedCharge(dimension('test.gb', u.GB, 0.1) as never)).toThrow(/per unit of time/)
  })
})
