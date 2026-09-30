// Cost tree shape: ordering, shares, dimension leaves, and the used / idle / fixed branches.
import { describe, expect, it } from 'vitest'
import {
  bill,
  dimension,
  evaluate,
  fixedCharge,
  gauge,
  instancePool,
  offering,
  q,
  request,
  scenario,
  service,
  u,
  workload,
  type CostNode,
} from '../../src/index.ts'
import { cpuS, H, instanceType, list, M, nodeAt, rps, storageDim } from './fixtures.ts'

// root 'shop' ($1/h instances, 1 GB each) with:
//   buy:    1 billed op ($1/M) + a call to `store.put` (1 MB written at $0.10/GB) + 500 millicore·s CPU
//   browse: 1 billed op
//   stored gauge: 100 GB at $0.10/GB-month
//   fixed: one $0.05/h load balancer
const ops = dimension('t.tree.ops', u.req, 1e-6)
const written = dimension('t.tree.written', u.GB, 0.1)
const stored = storageDim('t.tree.stored')
const lb = dimension('t.tree.lb', u.hour, 0.05)
const vm = instanceType('tree-vm')
const store = offering('store', {
  gauges: { bytes: gauge(u.byte, { billAs: stored }) },
  requests: () => ({ put: request({ bytes: u.byte }, (r) => ({ bill: [bill(written, r.bytes)] })) }),
})
const shop = service('shop', {
  deps: { store },
  pools: { vms: instancePool('tree-vms', { instance: vm, min: 2, loadFactor: 1, azs: 2 }) },
  gauges: { bytes: gauge(u.byte) },
  fixed: [fixedCharge(lb)],
  requests: ({ deps, pools }) => ({
    buy: request({}, () => ({
      bill: [bill(ops, q(1, u.req))],
      use: [pools.vms.cpu(q(500, cpuS))],
      calls: [deps.store.put({ bytes: q(1, u.MB) })],
    })),
    browse: request({}, () => ({ bill: [bill(ops, q(1, u.req))] })),
  }),
  gaugeMap: (g, { deps }) => [deps.store.gauges.bytes(g.bytes)],
})
const w = workload(shop, {
  requests: { buy: { rate: rps(1), attrs: {} }, browse: { rate: rps(10), attrs: {} } },
  gauges: { bytes: q(100, u.GB) },
})
const r = evaluate(
  scenario({ name: 'shop-scenario', description: 'tree test', root: shop, workload: w, pricing: list }),
)

// Hand computation (per 730-hour month, M = 2,628,000 s):
//   buy ops:        M × $1/M                    = $2.628
//   browse ops:     10 M × $1/M                 = $26.28
//   buy writes:     M × 1 MB = 2628 GB × $0.10  = $262.80
//   buy CPU:        500 millicore = 0.5 instance busy → 0.5 × $730 = $365   (pool: 1 instance needed, min 2)
//   idle headroom:  2 − 0.5 = 1.5 instances     = $1095
//   stored:         100 GB-month × $0.10        = $10
//   fixed lb:       730 h × $0.05               = $36.50
const BUY = 2.628 + 262.8 + 365
const BROWSE = 26.28
const GAUGES = 10
const IDLE = 1095
const FIXED = 36.5

const walk = (n: CostNode, f: (n: CostNode, parent?: CostNode) => void, parent?: CostNode) => {
  f(n, parent)
  for (const c of n.children ?? []) walk(c, f, n)
}

describe('cost tree', () => {
  it('has the scenario at the root and the expected totals', () => {
    expect(r.tree).toMatchObject({ name: 'shop-scenario', kind: 'root', share: 1 })
    expect(r.scenario).toBe('shop-scenario')
    expect(r.description).toBe('tree test')
    expect(r.total).toBeCloseTo(BUY + BROWSE + GAUGES + IDLE + FIXED, 6)
    expect(r.used).toBeCloseTo(BUY + BROWSE + GAUGES, 6)
    expect(r.idle).toBeCloseTo(IDLE, 6)
    expect(r.fixed).toBeCloseTo(FIXED, 9)
    expect(r.total).toBeCloseTo(
      r.dimensions.reduce((a, d) => a + d.cost, 0),
      9,
    )
  })

  it('puts used cost under the root service, idle and fixed on their own branches', () => {
    expect(r.tree.children!.map((c) => [c.name, c.kind])).toEqual([
      ['idle', 'idle'],
      ['shop', 'service'],
      ['fixed', 'fixed'],
    ])
    const shopNode = nodeAt(r.tree, ['shop'])
    expect(shopNode.children!.map((c) => c.name)).toEqual(['buy', 'browse', 'gauges'])
    expect(nodeAt(r.tree, ['shop', 'buy']).cost).toBeCloseTo(BUY, 6)
    expect(nodeAt(r.tree, ['shop', 'browse']).cost).toBeCloseTo(BROWSE, 9)
    expect(nodeAt(r.tree, ['shop', 'gauges']).cost).toBeCloseTo(GAUGES, 9)
  })

  it('sorts children by cost, descending, at every level', () => {
    walk(r.tree, (n) => {
      const costs = (n.children ?? []).map((c) => c.cost)
      expect(costs).toEqual([...costs].sort((a, b) => b - a))
    })
    // buy: pool $365 > store call $262.80 > its own ops $2.628
    expect(nodeAt(r.tree, ['shop', 'buy']).children!.map((c) => [c.name, c.kind])).toEqual([
      ['tree-vms', 'pool'],
      ['store', 'offering'],
      ['t.tree.ops', 'dimension'],
    ])
  })

  it('sums children to their parent and reports share as a fraction of the total', () => {
    walk(r.tree, (n) => {
      expect(n.share).toBeCloseTo(n.cost / r.total, 12)
      if (n.children) expect(n.children.reduce((a, c) => a + c.cost, 0)).toBeCloseTo(n.cost, 9)
    })
    expect(nodeAt(r.tree, ['idle']).share).toBeCloseTo(IDLE / r.total, 12)
  })

  it('ends every path in a dimension leaf that carries usage and unit; only leaves do', () => {
    walk(r.tree, (n) => {
      if (n.kind === 'dimension') {
        expect(n.children).toBeUndefined()
        expect(typeof n.usage).toBe('number')
        expect(typeof n.unit).toBe('string')
      } else {
        expect(n.children?.length).toBeGreaterThan(0)
        expect(n.usage).toBeUndefined()
        expect(n.unit).toBeUndefined()
      }
    })
    expect(nodeAt(r.tree, ['shop', 'browse', 't.tree.ops'])).toMatchObject({
      usage: expect.closeTo(10 * M, 3),
      unit: 'req',
    })
    expect(nodeAt(r.tree, ['shop', 'buy', 'store', 'put', 't.tree.written'])).toMatchObject({
      usage: expect.closeTo(2628, 9),
      unit: 'GB',
    })
    expect(nodeAt(r.tree, ['shop', 'buy', 'tree-vms', 't.vm.tree-vm.hours'])).toMatchObject({
      usage: expect.closeTo(0.5 * H, 9),
      unit: 'hour',
    })
    expect(nodeAt(r.tree, ['idle', 'tree-vms', 'headroom', 't.vm.tree-vm.hours'])).toMatchObject({
      usage: expect.closeTo(1.5 * H, 9),
      cost: expect.closeTo(IDLE, 6),
    })
    expect(nodeAt(r.tree, ['shop', 'gauges', 'store', 'gauges', 'bytes', 't.tree.stored'])).toMatchObject({
      usage: expect.closeTo(100, 9),
      unit: 'GB*month',
    })
    expect(nodeAt(r.tree, ['fixed', 'shop', 't.tree.lb'])).toMatchObject({ usage: expect.closeTo(H, 9), unit: 'hour' })
  })

  it('merges usage of one dimension reached from several requests into one leaf per path', () => {
    // ops is billed on two paths; each path has its own leaf, the dimension report has the sum
    const buyOps = nodeAt(r.tree, ['shop', 'buy', 't.tree.ops'])
    const browseOps = nodeAt(r.tree, ['shop', 'browse', 't.tree.ops'])
    expect(buyOps.usage! + browseOps.usage!).toBeCloseTo(11 * M, 3)
    expect(r.dimensions.find((d) => d.id === 't.tree.ops')!.usage).toBeCloseTo(11 * M, 3)
  })
})
