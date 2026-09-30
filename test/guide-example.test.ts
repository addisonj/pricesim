// examples/guide-example.ts is the model built in docs/guide.md; these checks keep the guide's numbers honest.
import { describe, expect, it } from 'vitest'
import scenario, { shared } from '../examples/guide-example.ts'
import { closedForm, evaluate, type CostNode } from '../src/index.ts'

const r = evaluate(scenario)
const HOURS = 730

const dim = (id: string) => r.dimensions.find((d) => d.id === id)!
const pool = (name: string) => r.pools.find((p) => p.name === name)!
const child = (n: CostNode, name: string) => n.children!.find((c) => c.name === name)!

describe('guide example', () => {
  it('matches the totals quoted in the guide', () => {
    expect(r.total).toBeCloseTo(7979.03, 1)
    expect(r.used).toBeCloseTo(7465.12, 1)
    expect(r.idle).toBeCloseTo(497.48, 1)
    expect(r.fixed).toBeCloseTo(16.43, 1)
    expect(r.used + r.idle + r.fixed).toBeCloseTo(r.total, 6)
  })

  it('sizes the pools as the guide describes', () => {
    expect(pool('search-nodes')).toMatchObject({ count: 5, binding: 'memory', instance: 'r7g.large' })
    expect(pool('uploads-api')).toMatchObject({ count: 2, binding: 'min' })
    expect(pool('general')).toMatchObject({ count: 3, binding: 'min' })
  })

  it('bills the ALB hour as a fixed charge and the node pool fully', () => {
    expect(dim('aws.elb.alb.hours').cost).toBeCloseTo(HOURS * 0.0225, 6)
    expect(dim('aws.ec2.m7g.xlarge.hours').usage).toBeCloseTo(3 * HOURS, 6)
    const idle = child(child(r.tree, 'idle'), 'general')
    expect(idle.children!.map((c) => c.name).sort()).toEqual(
      ['node slack', 'pod headroom: uploads-api', 'system overhead'].sort(),
    )
  })

  it('applies the queue free tier to the pooled monthly requests', () => {
    const q = dim('example.queue.requests')
    expect(q.cost).toBeCloseTo((q.usage - 1e6) * 0.4e-6, 6)
  })

  it('agrees with the exact closed form at the operating point', () => {
    const cf = closedForm(scenario)
    expect(cf.value).toBeCloseTo(r.total, 4)
  })

  it('attributes cost per tenant in the shared scenario', () => {
    const s = evaluate(shared)
    const t = Object.fromEntries(s.tenants!.map((x) => [x.id, x]))
    expect(t.small!.total + t.large!.total).toBeCloseTo(s.total, 6)
    expect(t.small!.used).toBeLessThan(t.large!.used / 10)
  })
})
