// Allocation of provisioned capacity (DESIGN.md §6.2 step 5, §6.4): used vs idle, instance-hours fully
// allocated, pod headroom / system overhead / node slack, and the split of a shared node pool.
// All instances are $1/h, so one instance (or node) for the 730-hour month costs $730.
import { describe, expect, it } from 'vitest'
import {
  dimension,
  evaluate,
  fixedCharge,
  gauge,
  instancePool,
  nodePool,
  pods,
  q,
  request,
  scenario,
  service,
  u,
  workload,
} from '../../src/index.ts'
import { cpuS, dimOf, H, instanceType, leafPaths, list, nodeAt, poolOf, rps } from './fixtures.ts'

describe('instance pool allocation', () => {
  const small = instanceType('alloc-small') // 1000 millicore, 1 GB, $1/h
  const lb = dimension('t.alloc.lb', u.hour, 0.1)
  const svc = service('svc', {
    pools: { vms: instancePool('alloc-vms', { instance: small, min: 1, loadFactor: 0.5, azs: 3 }) },
    gauges: { items: gauge(u.count) },
    fixed: [fixedCharge(lb)],
    requests: ({ pools }) => ({
      compute: request({}, () => ({ use: [pools.vms.cpu(q(100, cpuS))] })),
    }),
    gaugeUse: (g, { pools }) => [pools.vms.memory(g.items.mul(q(1, u.MB.div(u.count))))],
  })
  const run = (compute: number, items = 0) =>
    evaluate(
      scenario({
        name: 'alloc',
        root: svc,
        workload: workload(svc, {
          requests: compute ? { compute: { rate: rps(compute), attrs: {} } } : {},
          gauges: { items: q(items, u.count) },
        }),
        pricing: list,
      }),
    )

  it('splits instance-hours into used and idle headroom, with fixed charges on their own', () => {
    // 25 req/s → 2500 millicore → 5 instances (loadFactor 0.5)
    //   used: 2500 millicore / 1000 per instance = 2.5 instances busy → 2.5 × $730 = $1825
    //   idle: 5 − 2.5 = 2.5 → $1825
    //   fixed: 1 load balancer × 730 h × $0.10 = $73
    const r = run(25)
    expect(poolOf(r, 'alloc-vms').count).toBe(5)
    expect(r.used).toBeCloseTo(1825, 6)
    expect(r.idle).toBeCloseTo(1825, 6)
    expect(r.fixed).toBeCloseTo(73, 9)
    expect(r.total).toBeCloseTo(3723, 6)
    expect(r.used + r.idle + r.fixed).toBeCloseTo(r.total, 9)
    expect(nodeAt(r.tree, ['svc', 'compute', 'alloc-vms']).cost).toBeCloseTo(1825, 6)
    expect(nodeAt(r.tree, ['idle', 'alloc-vms', 'headroom']).cost).toBeCloseTo(1825, 6)
    expect(nodeAt(r.tree, ['fixed', 'svc', 't.alloc.lb']).cost).toBeCloseTo(73, 9)
  })

  it('allocates every provisioned instance-hour (count × hours)', () => {
    for (const [rate, count] of [
      [0, 1],
      [1, 1],
      [25, 5],
      [37, 8],
    ] as const) {
      const r = run(rate)
      expect(poolOf(r, 'alloc-vms').count).toBe(count)
      const d = dimOf(r, 't.vm.alloc-small.hours')
      expect(d.usage).toBeCloseTo(count * H, 6)
      expect(d.cost).toBeCloseTo(count * H, 6)
    }
  })

  it('charges non-binding resources too (dominant share): request CPU on a memory-bound pool', () => {
    // 2000 items × 1 MB = 2 GB → 4 instances, memory binds; 1 req/s of compute uses 100 millicore.
    // Each path pays its dominant share, max over resources of usage / capacity, in instances:
    //   gauges:  memory 2 GB / 1 GB per instance       = 2 instances   → $1460
    //   compute: cpu 100 / 1000 millicore per instance = 0.1 instance  → $73
    //   idle headroom: 4 − 2 − 0.1 = 1.9                               → $1387
    // (Before dominant-share attribution the compute path was not charged and headroom was $1460.)
    const r = run(1, 2000)
    expect(poolOf(r, 'alloc-vms')).toMatchObject({ count: 4, binding: 'memory' })
    expect(nodeAt(r.tree, ['svc', 'gauges', 'memory', 'alloc-vms']).cost).toBeCloseTo(2 * H, 6)
    expect(nodeAt(r.tree, ['svc', 'compute', 'alloc-vms']).cost).toBeCloseTo(0.1 * H, 6)
    expect(nodeAt(r.tree, ['idle', 'alloc-vms', 'headroom']).cost).toBeCloseTo(1.9 * H, 6)
    // only the split between used and idle moved: the total is still 4 instances
    expect(r.total).toBeCloseTo(4 * H + 73, 6)
    expect(r.used + r.idle + r.fixed).toBeCloseTo(r.total, 9)
  })

  it('charges a path its dominant resource, not the sum over resources', () => {
    // one request uses 100 millicore·s of CPU (0.1 instance) and 300 KB of network (3e5 / 1e6 byte/s = 0.3
    // instance) at 1 req/s: it pays max(0.1, 0.3) = 0.3 instance → $219; 1 instance (network 3e5 / 5e5 → 1)
    const vm = instanceType('alloc-dom') // 1000 millicore, 1 GB, 1e6 byte/s, $1/h
    const dom = service('dom', {
      pools: { vms: instancePool('alloc-dom', { instance: vm, min: 1, loadFactor: 0.5, azs: 1 }) },
      requests: ({ pools }) => ({
        both: request({}, () => ({ use: [pools.vms.cpu(q(100, cpuS)), pools.vms.network(q(300, u.KB))] })),
      }),
    })
    const w = workload(dom, { requests: { both: { rate: rps(1), attrs: {} } } })
    const r = evaluate(scenario({ name: 'dom', root: dom, workload: w, pricing: list }))
    expect(poolOf(r, 'alloc-dom')).toMatchObject({ count: 1, binding: 'network' })
    expect(nodeAt(r.tree, ['dom', 'both', 'alloc-dom']).cost).toBeCloseTo(0.3 * H, 6)
    expect(nodeAt(r.tree, ['idle', 'alloc-dom', 'headroom']).cost).toBeCloseTo(0.7 * H, 6)
    expect(r.total).toBeCloseTo(H, 9)
  })

  it('scales dominant shares down when they add up to more than the pool', () => {
    // loadFactor 1, one instance (1000 millicore, 1 GB): a gauge holds the full 1 GB (share 1) and a request
    // uses the full 1000 millicore (share 1). Shares sum to 2 > 1 instance, so each is scaled by 1/2:
    //   gauges $365, request $365, idle $0
    const vm = instanceType('alloc-over')
    const over = service('over', {
      pools: { vms: instancePool('alloc-over', { instance: vm, min: 1, loadFactor: 1, azs: 1 }) },
      gauges: { gb: gauge(u.count) },
      requests: ({ pools }) => ({ burn: request({}, () => ({ use: [pools.vms.cpu(q(1000, cpuS))] })) }),
      gaugeUse: (g, { pools }) => [pools.vms.memory(g.gb.mul(q(1, u.GB.div(u.count))))],
    })
    const w = workload(over, { requests: { burn: { rate: rps(1), attrs: {} } }, gauges: { gb: q(1, u.count) } })
    const r = evaluate(scenario({ name: 'over', root: over, workload: w, pricing: list }))
    expect(poolOf(r, 'alloc-over').count).toBe(1)
    expect(nodeAt(r.tree, ['over', 'gauges', 'memory', 'alloc-over']).cost).toBeCloseTo(H / 2, 6)
    expect(nodeAt(r.tree, ['over', 'burn', 'alloc-over']).cost).toBeCloseTo(H / 2, 6)
    expect(r.idle).toBeCloseTo(0, 6)
    expect(r.total).toBeCloseTo(H, 9)
  })

  it('charges an unused pool entirely as idle', () => {
    const r = run(0)
    expect(r.used).toBe(0)
    expect(r.idle).toBeCloseTo(H, 9)
    expect(r.used + r.idle + r.fixed).toBeCloseTo(r.total, 9)
  })
})

describe('node pool allocation', () => {
  // node: 4000 millicore, 8 GB, $1/h; reserved 1000 millicore + 2 GB; packing 0.75; maxPods 10; min 1
  const node4 = instanceType('alloc-node4', { millicores: 4000, memoryGB: 8 })
  const makePool = (name: string) =>
    nodePool(name, {
      instance: node4,
      min: 1,
      azs: 3,
      reserved: { cpu: q(1000, u.millicore), memory: q(2, u.GB) },
      maxPods: 10,
      packingEfficiency: 0.75,
    })

  describe('CPU-bound pool shared by two services', () => {
    const shared = makePool('shared')
    // pods: 500 millicore + 0.5 GB requested, min 2 replicas, target 50% (250 millicore usable per pod)
    const podSpec = {
      on: shared,
      request: { cpu: q(500, u.millicore), memory: q(0.5, u.GB) },
      minReplicas: 2,
      targetUtilization: 0.5,
    }
    const alpha = service('alpha', {
      pools: { p: pods('alpha-pods', podSpec) },
      requests: ({ pools }) => ({ work: request({}, () => ({ use: [pools.p.cpu(q(100, cpuS))] })) }),
    })
    const beta = service('beta', {
      pools: { p: pods('beta-pods', podSpec) },
      requests: ({ pools }) => ({ work: request({}, () => ({ use: [pools.p.cpu(q(300, cpuS))] })) }),
    })
    const root = service('root', {
      deps: { alpha, beta },
      requests: ({ deps }) => ({ go: request({}, () => ({ calls: [deps.alpha.work({}), deps.beta.work({})] })) }),
    })
    const w = workload(root, { requests: { go: { rate: rps(1), attrs: {} } } })
    const r = evaluate(scenario({ name: 'shared-cpu', root, workload: w, pricing: list }))

    it('sizes pods and nodes', () => {
      // alpha: 100 millicore / 250 → 1 → min 2; beta: 300 / 250 → 2
      expect(poolOf(r, 'alpha-pods')).toMatchObject({ count: 2, binding: 'min' })
      expect(poolOf(r, 'beta-pods')).toMatchObject({ count: 2, binding: 'cpu' })
      // 4 × 500 = 2000 millicore / 2250 → 1 node; cpu wins the tie with memory and maxPods
      expect(poolOf(r, 'shared')).toMatchObject({ count: 1, binding: 'cpu' })
    })

    it('breaks the node-hours into used, pod headroom, system overhead and node slack', () => {
      // fractions of one node's 4000 millicore over the month ($730):
      //   alpha used      100 / 4000                 = 0.025 → $18.25
      //   beta used       300 / 4000                 = 0.075 → $54.75
      //   alpha headroom  2 × 500 / 4000 − 0.025     = 0.225 → $164.25
      //   beta headroom   2 × 500 / 4000 − 0.075     = 0.175 → $127.75
      //   system          1 node × 1000 / 4000       = 0.25  → $182.50
      //   slack           1 − 0.5 − 0.25             = 0.25  → $182.50
      const at = (...path: string[]) => nodeAt(r.tree, path).cost
      expect(at('root', 'go', 'alpha', 'work', 'alpha-pods')).toBeCloseTo(18.25, 9)
      expect(at('root', 'go', 'beta', 'work', 'beta-pods')).toBeCloseTo(54.75, 9)
      expect(at('idle', 'shared', 'pod headroom: alpha-pods')).toBeCloseTo(164.25, 9)
      expect(at('idle', 'shared', 'pod headroom: beta-pods')).toBeCloseTo(127.75, 9)
      expect(at('idle', 'shared', 'system overhead')).toBeCloseTo(182.5, 9)
      expect(at('idle', 'shared', 'node slack')).toBeCloseTo(182.5, 9)
      expect(r.used).toBeCloseTo(73, 9)
      expect(r.idle).toBeCloseTo(657, 9)
      expect(r.total).toBeCloseTo(H, 9)
    })

    it('splits used cost in proportion to usage of the binding dimension (1 : 3)', () => {
      const a = nodeAt(r.tree, ['root', 'go', 'alpha']).cost
      const b = nodeAt(r.tree, ['root', 'go', 'beta']).cost
      expect(b / a).toBeCloseTo(3, 9)
    })
  })

  describe('memory-bound pool shared by two services', () => {
    const memPool = makePool('mem-shared')
    // pods: 500 millicore + 2 GB requested, min 1, target 100%
    const podSpec = {
      on: memPool,
      request: { cpu: q(500, u.millicore), memory: q(2, u.GB) },
      minReplicas: 1,
      targetUtilization: 1,
    }
    const cacheSvc = (name: string, cpu: number) =>
      service(name, {
        pools: { p: pods(`${name}-pods`, podSpec) },
        gauges: { gb: gauge(u.count) },
        requests: ({ pools }) => ({ work: request({}, () => ({ use: [pools.p.cpu(q(cpu, cpuS))] })) }),
        gaugeUse: (g, { pools }) => [pools.p.memory(g.gb.mul(q(1, u.GB.div(u.count))))],
      })
    // `a` is CPU-heavy but holds little memory; `b` holds 3× the memory
    const a = cacheSvc('a', 200)
    const b = cacheSvc('b', 10)
    const root = service('mroot', {
      deps: { a, b },
      gauges: { a: gauge(u.count), b: gauge(u.count) },
      requests: ({ deps }) => ({ go: request({}, () => ({ calls: [deps.a.work({}), deps.b.work({})] })) }),
      gaugeMap: (g, { deps }) => [deps.a.gauges.gb(g.a), deps.b.gauges.gb(g.b)],
    })
    const w = workload(root, {
      requests: { go: { rate: rps(1), attrs: {} } },
      gauges: { a: q(1, u.count), b: q(3, u.count) },
    })
    const r = evaluate(scenario({ name: 'shared-mem', root, workload: w, pricing: list }))

    it('sizes on memory', () => {
      // a: 1 GB / 2 GB → 1 replica (cpu 200/500 → 1); b: 3 GB / 2 GB → 2 replicas
      expect(poolOf(r, 'a-pods')).toMatchObject({ count: 1 })
      expect(poolOf(r, 'b-pods')).toMatchObject({ count: 2, binding: 'memory' })
      // 3 × 2 GB = 6 GB / 4.5 → 2 nodes; cpu 1500 / 2250 → 1
      expect(poolOf(r, 'mem-shared')).toMatchObject({ count: 2, binding: 'memory' })
    })

    it('charges each path its dominant share: memory held, and the CPU its requests use', () => {
      // one node: 4000 millicore, 8 GB; $730 per node-month; 2 nodes = $1460. Per path, the dominant share of
      // one node, max over resources of usage / node capacity:
      //   a gauges    memory 1 GB / 8                          = 0.125   → $91.25
      //   a work      cpu 200 / 4000 (1 req/s × 200 millicore·s) = 0.05    → $36.50
      //   b gauges    memory 3 GB / 8                          = 0.375   → $273.75
      //   b work      cpu 10 / 4000                            = 0.0025  → $1.825
      // Each pod group's requests, dominant share: a 1 × max(500/4000, 2/8) = 0.25, b 2 × 0.25 = 0.5
      //   a headroom  0.25 − 0.125 − 0.05                      = 0.075   → $54.75
      //   b headroom  0.5 − 0.375 − 0.0025                     = 0.1225  → $89.425
      //   system      2 nodes × max(1000/4000, 2/8)            = 0.5     → $365
      //   slack       2 − 0.25 − 0.5 − 0.5                     = 0.75    → $547.50
      // (Before dominant-share attribution only memory was charged: the work paths were free and the
      // headrooms were $91.25 each. System overhead, slack and the total are unchanged.)
      const at = (...path: string[]) => nodeAt(r.tree, path).cost
      expect(at('mroot', 'gauges', 'a', 'gauges', 'memory', 'a-pods')).toBeCloseTo(91.25, 9)
      expect(at('mroot', 'gauges', 'b', 'gauges', 'memory', 'b-pods')).toBeCloseTo(273.75, 9)
      expect(at('mroot', 'go', 'a', 'work', 'a-pods')).toBeCloseTo(36.5, 9)
      expect(at('mroot', 'go', 'b', 'work', 'b-pods')).toBeCloseTo(1.825, 9)
      expect(at('idle', 'mem-shared', 'pod headroom: a-pods')).toBeCloseTo(54.75, 9)
      expect(at('idle', 'mem-shared', 'pod headroom: b-pods')).toBeCloseTo(89.425, 9)
      expect(at('idle', 'mem-shared', 'system overhead')).toBeCloseTo(365, 9)
      expect(at('idle', 'mem-shared', 'node slack')).toBeCloseTo(547.5, 9)
      expect(r.used).toBeCloseTo(403.325, 9)
      expect(r.idle).toBeCloseTo(1056.675, 9)
      expect(r.total).toBeCloseTo(2 * H, 9)
    })
  })

  it('scales pod-group shares down when their dominant shares add up to more than the pool', () => {
    // one node: 4000 millicore, 8 GB, no reservation, perfect packing. Group x requests all the CPU and no
    // memory, group y all the memory and no CPU: 1 node (cpu 4000 / 4000, memory 8 / 8), but the dominant
    // shares of the requests are 1 + 1 = 2 nodes, so everything is scaled by 1/2:
    //   x: allotment 0.5; used cpu 2000 / 4000 = 0.5 × 1/2 = 0.25 → $182.50; headroom 0.25 → $182.50
    //   y: allotment 0.5; used memory 8 / 8 = 1 × 1/2 = 0.5 → $365; headroom 0
    //   system 0, slack 1 − 2 × 1/2 = 0
    const np = nodePool('np-over', {
      instance: node4,
      min: 1,
      azs: 1,
      reserved: { cpu: q(0, u.millicore), memory: q(0, u.GB) },
      maxPods: 10,
      packingEfficiency: 1,
    })
    const x = service('x', {
      pools: {
        p: pods('x-pods', {
          on: np,
          request: { cpu: q(4000, u.millicore), memory: q(0, u.GB) },
          minReplicas: 1,
          targetUtilization: 1,
        }),
      },
      requests: ({ pools }) => ({ work: request({}, () => ({ use: [pools.p.cpu(q(2000, cpuS))] })) }),
    })
    const y = service('y', {
      pools: {
        p: pods('y-pods', {
          on: np,
          request: { cpu: q(0, u.millicore), memory: q(8, u.GB) },
          minReplicas: 1,
          targetUtilization: 1,
        }),
      },
      gauges: { gb: gauge(u.count) },
      requests: () => ({}),
      gaugeUse: (g, { pools }) => [pools.p.memory(g.gb.mul(q(1, u.GB.div(u.count))))],
    })
    const root = service('xy', {
      deps: { x, y },
      gauges: { gb: gauge(u.count) },
      requests: ({ deps }) => ({ go: request({}, () => ({ calls: [deps.x.work({})] })) }),
      gaugeMap: (g, { deps }) => [deps.y.gauges.gb(g.gb)],
    })
    const w = workload(root, { requests: { go: { rate: rps(1), attrs: {} } }, gauges: { gb: q(8, u.count) } })
    const r = evaluate(scenario({ name: 'np-over', root, workload: w, pricing: list }))
    expect(poolOf(r, 'np-over').count).toBe(1)
    const at = (...path: string[]) => nodeAt(r.tree, path).cost
    expect(at('xy', 'go', 'x', 'work', 'x-pods')).toBeCloseTo(182.5, 9)
    expect(at('xy', 'gauges', 'y', 'gauges', 'memory', 'y-pods')).toBeCloseTo(365, 9)
    expect(at('idle', 'np-over', 'pod headroom: x-pods')).toBeCloseTo(182.5, 9)
    expect(at('idle', 'np-over', 'pod headroom: y-pods')).toBeCloseTo(0, 9)
    expect(at('idle', 'np-over', 'node slack')).toBeCloseTo(0, 9)
    expect(r.total).toBeCloseTo(H, 9)
  })

  it('keeps used + idle + fixed = total and allocates all node-hours', () => {
    const np = makePool('np-inv')
    const svc = service('inv', {
      pools: {
        p: pods('inv-pods', {
          on: np,
          request: { cpu: q(500, u.millicore), memory: q(0.5, u.GB) },
          minReplicas: 1,
          targetUtilization: 0.5,
        }),
      },
      requests: ({ pools }) => ({ work: request({}, () => ({ use: [pools.p.cpu(q(100, cpuS))] })) }),
    })
    // 30 req/s → 3000 millicore / 250 = 12 pods → 6000 / 2250 → 3 nodes; pods 12 / 10 → 2
    const w = workload(svc, { requests: { work: { rate: rps(30), attrs: {} } } })
    const r = evaluate(scenario({ name: 'inv', root: svc, workload: w, pricing: list }))
    expect(poolOf(r, 'np-inv')).toMatchObject({ count: 3, binding: 'cpu' })
    expect(dimOf(r, 't.vm.alloc-node4.hours').usage).toBeCloseTo(3 * H, 6)
    expect(r.used + r.idle + r.fixed).toBeCloseTo(r.total, 9)
    // used 3000 / 4000 = 0.75 node → $547.50
    expect(r.used).toBeCloseTo(547.5, 6)
    expect(r.total).toBeCloseTo(3 * H, 6)
  })
})
