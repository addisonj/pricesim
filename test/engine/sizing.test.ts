// Capacity sizing (DESIGN.md §6.2, §6.4): instance pools, pod replicas and node pools.
import { describe, expect, it } from 'vitest'
import {
  evaluate,
  gauge,
  instancePool,
  nodePool,
  param,
  pods,
  q,
  request,
  scenario,
  series,
  service,
  u,
  workload,
  type InstancePoolSpec,
  type NodePoolSpec,
} from '../../src/index.ts'
import { cpuS, H, instanceType, list, perSecond, poolOf, rps } from './fixtures.ts'

describe('instance pools', () => {
  // 1 vCPU (1000 millicore), 1 GB, 1e6 byte/s, $1/h
  const small = instanceType('sizing-small')
  /**
   * A service with one instance pool:
   *   compute: 100 millicore·s per request   → rate × 100 millicore of CPU demand
   *   transfer: 100 KB per request            → rate × 1e5 byte/s of network demand
   *   items gauge: 1 MB of memory per item
   */
  const svc = (name: string, spec: Partial<InstancePoolSpec> = {}) =>
    service(name, {
      pools: { vms: instancePool(name, { instance: small, min: 1, loadFactor: 0.5, azs: 3, ...spec }) },
      gauges: { items: gauge(u.count) },
      requests: ({ pools }) => ({
        compute: request({}, () => ({ use: [pools.vms.cpu(q(100, cpuS))] })),
        transfer: request({}, () => ({ use: [pools.vms.network(q(100, u.KB))] })),
      }),
      gaugeUse: (g, { pools }) => [pools.vms.memory(g.items.mul(q(1, u.MB.div(u.count))))],
    })
  const run = (
    name: string,
    load: { compute?: number; transfer?: number; items?: number },
    spec: Partial<InstancePoolSpec> = {},
  ) => {
    const s = svc(name, spec)
    const w = workload(s, {
      requests: {
        ...(load.compute ? { compute: { rate: rps(load.compute), attrs: {} } } : {}),
        ...(load.transfer ? { transfer: { rate: rps(load.transfer), attrs: {} } } : {}),
      },
      gauges: { items: q(load.items ?? 0, u.count) },
    })
    return poolOf(evaluate(scenario({ name, root: s, workload: w, pricing: list })), name)
  }

  it('binds on CPU', () => {
    // 25 req/s × 100 millicore·s = 2500 millicore; / (1000 × 0.5) = 5 instances
    const p = run('cpu-bound', { compute: 25 })
    expect(p).toMatchObject({ kind: 'instances', instance: 'sizing-small', count: 5, min: 1, binding: 'cpu' })
    expect(p.resources.cpu).toEqual({ peak: 2500, mean: 2500, capacity: 5000 })
  })

  it('binds on memory held by gauges', () => {
    // 2000 items × 1 MB = 2 GB; / (1 GB × 0.5) = 4 instances
    const p = run('memory-bound', { items: 2000 })
    expect(p).toMatchObject({ count: 4, binding: 'memory' })
    expect(p.resources.memory).toEqual({ peak: 2e9, mean: 2e9, capacity: 4e9 })
  })

  it('binds on network', () => {
    // 20 req/s × 100 KB = 2e6 byte/s; / (1e6 × 0.5) = 4 instances
    const p = run('network-bound', { transfer: 20 })
    expect(p).toMatchObject({ count: 4, binding: 'network' })
    expect(p.resources.network!.peak).toBeCloseTo(2e6, 6)
  })

  it('takes the largest requirement across dimensions', () => {
    // cpu: 25 req/s → 5; memory: 3000 items → 3 GB / 0.5 GB = 6 → 6 instances, memory binds
    expect(run('mixed', { compute: 25, items: 3000 })).toMatchObject({ count: 6, binding: 'memory' })
  })

  it('applies the load factor and rounds up', () => {
    // 25 req/s → 2500 millicore at loadFactor 1 → 2.5 → 3 instances
    expect(run('lf-1', { compute: 25 }, { loadFactor: 1 })).toMatchObject({ count: 3, binding: 'cpu' })
    // at loadFactor 0.25 → 2500 / 250 = 10
    expect(run('lf-quarter', { compute: 25 }, { loadFactor: 0.25 })).toMatchObject({ count: 10 })
  })

  it('reports min as the binding constraint only when it is strictly larger', () => {
    // 1 req/s → 100 millicore → 0.2 instance → ceil 1 < min 3
    expect(run('min-binds', { compute: 1 }, { min: 3 })).toMatchObject({ count: 3, binding: 'min' })
    // 15 req/s → 1500 millicore / 500 = 3 = min 3: the dimension is reported
    expect(run('min-ties', { compute: 15 }, { min: 3 })).toMatchObject({ count: 3, binding: 'cpu' })
  })

  it('provisions unused pools at their minimum, including pools of deps that are never called', () => {
    const vm = instanceType('sizing-idle-vm')
    const db = service('db', {
      pools: { vms: instancePool('db-vms', { instance: vm, min: 2, loadFactor: 0.5, azs: 2 }) },
      requests: ({ pools }) => ({ query: request({}, () => ({ use: [pools.vms.cpu(q(1, cpuS))] })) }),
    })
    const cache = service('cache', {
      deps: { db },
      requests: ({ deps }) => ({ get: request({}, () => ({ calls: [deps.db.query({})] })) }),
    })
    const front = service('front', {
      deps: { cache },
      requests: ({ deps }) => ({ get: request({}, () => ({ calls: [deps.cache.get({})] })) }),
    })
    const r = evaluate(
      scenario({ name: 'idle', root: front, workload: workload(front, { requests: {} }), pricing: list }),
    )
    expect(poolOf(r, 'db-vms')).toMatchObject({ count: 2, min: 2, binding: 'min' })
    // 2 × 730 h × $1, all of it idle
    expect(r.total).toBeCloseTo(2 * H, 9)
    expect(r.idle).toBeCloseTo(2 * H, 9)
    expect(r.used).toBeCloseTo(0, 9)
  })
})

describe('pod replicas', () => {
  // node pool large enough that it never matters here
  const big = instanceType('sizing-pod-node', { millicores: 64_000, memoryGB: 256 })
  const np = nodePool('replica-nodes', {
    instance: big,
    min: 1,
    azs: 1,
    reserved: { cpu: q(0, u.millicore), memory: q(0, u.GB) },
    maxPods: 100,
    packingEfficiency: 1,
  })
  // per pod: 500 millicore, 1 GB requested; target 50% → 250 millicore / 0.5 GB usable
  const web = service('web', {
    pools: {
      pods: pods('web', {
        on: np,
        request: { cpu: q(500, u.millicore), memory: q(1, u.GB) },
        minReplicas: 1,
        targetUtilization: 0.5,
      }),
    },
    gauges: { items: gauge(u.count) },
    requests: ({ pools }) => ({ hit: request({}, () => ({ use: [pools.pods.cpu(q(250, cpuS))] })) }),
    gaugeUse: (g, { pools }) => [pools.pods.memory(g.items.mul(q(1, u.MB.div(u.count))))],
  })

  it('sizes replicas from the peak, not the mean', () => {
    // 1 then 3 req/s for an hour each: demand 250 then 750 millicore
    //   peak 750 / 250 = 3 replicas (the mean, 500, would give 2)
    const w = workload(web, {
      period: q(2, u.hour),
      requests: { hit: { rate: series.fromArray([q(1, perSecond), q(3, perSecond)], 3600), attrs: {} } },
    })
    const p = poolOf(evaluate(scenario({ name: 'peak', root: web, workload: w, pricing: list })), 'web')
    expect(p).toMatchObject({ kind: 'pods', nodePool: 'replica-nodes', count: 3, min: 1, binding: 'cpu' })
    expect(p.resources.cpu).toEqual({ peak: 750, mean: 500, capacity: 1500 })
  })

  it('binds on memory held by gauges', () => {
    // 1500 items × 1 MB = 1.5 GB / 0.5 GB = 3 replicas
    const w = workload(web, { requests: {}, gauges: { items: q(1500, u.count) } })
    const p = poolOf(evaluate(scenario({ name: 'mem', root: web, workload: w, pricing: list })), 'web')
    expect(p).toMatchObject({ count: 3, binding: 'memory' })
    expect(p.resources.memory!.capacity).toBe(3e9)
  })

  it('keeps minReplicas when demand is lower; min binds only when strictly larger', () => {
    // 0.1 req/s → 25 millicore / 250 = 0.1 → ceil 1 = minReplicas 1: the dimension is reported
    const w = workload(web, { requests: { hit: { rate: rps(0.1), attrs: {} } } })
    const p = poolOf(evaluate(scenario({ name: 'min-tie', root: web, workload: w, pricing: list })), 'web')
    expect(p).toMatchObject({ count: 1, binding: 'cpu' })
    // same demand with minReplicas 3 → 3 replicas, min binds
    const floor3 = service('floor3', {
      pools: {
        pods: pods('floor3', {
          on: np,
          request: { cpu: q(500, u.millicore), memory: q(1, u.GB) },
          minReplicas: 3,
          targetUtilization: 0.5,
        }),
      },
      requests: ({ pools }) => ({ hit: request({}, () => ({ use: [pools.pods.cpu(q(250, cpuS))] })) }),
    })
    const w3 = workload(floor3, { requests: { hit: { rate: rps(0.1), attrs: {} } } })
    const p3 = poolOf(evaluate(scenario({ name: 'min', root: floor3, workload: w3, pricing: list })), 'floor3')
    expect(p3).toMatchObject({ count: 3, min: 3, binding: 'min' })
  })

  // BUG (src/eval/usage.ts): pod requests (and instance/node capacities) are evaluated with `.eval()` and no
  // bindings, so a param in a pod request ignores the workload's override.
  //   expected: podCpu overridden to 1000 millicore → 1000 millicore demand / 1000 = 1 replica
  //   actual:   the default 500 millicore is used → 2 replicas
  it('applies workload param overrides to pod requests', () => {
    const tunable = service('tunable', {
      pools: {
        pods: pods('tunable', {
          on: np,
          request: { cpu: param('podCpu', q(500, u.millicore)), memory: q(1, u.GB) },
          minReplicas: 1,
          targetUtilization: 1,
        }),
      },
      requests: ({ pools }) => ({ hit: request({}, () => ({ use: [pools.pods.cpu(q(1000, cpuS))] })) }),
    })
    const w = workload(tunable, {
      requests: { hit: { rate: rps(1), attrs: {} } },
      params: { podCpu: q(1000, u.millicore) },
    })
    const p = poolOf(evaluate(scenario({ name: 'param-pod', root: tunable, workload: w, pricing: list })), 'tunable')
    expect(p.count).toBe(1)
  })
})

describe('node pools', () => {
  // 4000 millicore, 8 GB, $1/h. Defaults: reserved 1000 millicore + 2 GB, packing 0.75, maxPods 10, min 1,
  // so each node offers (4000 - 1000) × 0.75 = 2250 millicore and (8 - 2) × 0.75 = 4.5 GB to pods.
  const node4 = instanceType('sizing-node4', { millicores: 4000, memoryGB: 8 })
  /** A cluster whose pod groups have no load, so each runs exactly `replicas` (= minReplicas) pods. */
  const cluster = (
    name: string,
    groups: readonly { cpu: number; memGB: number; replicas: number }[],
    spec: Partial<NodePoolSpec> & { reservedCpu?: number; reservedGB?: number } = {},
  ) => {
    const np = nodePool(name, {
      instance: node4,
      min: spec.min ?? 1,
      azs: 3,
      reserved: { cpu: q(spec.reservedCpu ?? 1000, u.millicore), memory: q(spec.reservedGB ?? 2, u.GB) },
      maxPods: spec.maxPods ?? 10,
      packingEfficiency: spec.packingEfficiency ?? 0.75,
    })
    const deps = Object.fromEntries(
      groups.map((g, i) => [
        `g${i}`,
        service(`${name}-svc${i}`, {
          pools: {
            p: pods(`${name}-pods${i}`, {
              on: np,
              request: { cpu: q(g.cpu, u.millicore), memory: q(g.memGB, u.GB) },
              minReplicas: g.replicas,
              targetUtilization: 0.5,
            }),
          },
          requests: () => ({}),
        }),
      ]),
    )
    const root = service(`${name}-root`, { deps, requests: () => ({}) })
    return evaluate(scenario({ name, root, workload: workload(root, { requests: {} }), pricing: list }))
  }

  it('binds on summed CPU requests after reserved capacity and packing', () => {
    // 10 × 500 = 5000 millicore / 2250 = 2.2 → 3 nodes; memory 10 × 0.5 = 5 GB / 4.5 → 2; pods 10/10 → 1
    const r = cluster('np-cpu', [{ cpu: 500, memGB: 0.5, replicas: 10 }])
    const p = poolOf(r, 'np-cpu')
    expect(p).toMatchObject({ kind: 'nodes', instance: 'sizing-node4', count: 3, min: 1, binding: 'cpu' })
    expect(p.resources.cpu).toEqual({ peak: 5000, mean: 5000, capacity: 12_000 })
    expect(p.resources.memory).toEqual({ peak: 5e9, mean: 5e9, capacity: 24e9 })
    expect(r.total).toBeCloseTo(3 * H, 9)
  })

  it('counts reserved system capacity', () => {
    // no reservation: 5000 / (4000 × 0.75 = 3000) → 2 nodes
    expect(
      poolOf(cluster('np-noreserve', [{ cpu: 500, memGB: 0.5, replicas: 10 }], { reservedCpu: 0 }), 'np-noreserve'),
    ).toMatchObject({ count: 2, binding: 'cpu' })
  })

  it('counts packing efficiency', () => {
    // perfect packing: 5000 / (3000 × 1) → 2 nodes
    const r = cluster('np-pack', [{ cpu: 500, memGB: 0.5, replicas: 10 }], { packingEfficiency: 1 })
    expect(poolOf(r, 'np-pack')).toMatchObject({ count: 2, binding: 'cpu' })
  })

  it('binds on memory', () => {
    // cpu 5 × 100 = 500 / 2250 → 1; memory 5 × 2 GB = 10 GB / 4.5 → 3
    const r = cluster('np-mem', [{ cpu: 100, memGB: 2, replicas: 5 }])
    expect(poolOf(r, 'np-mem')).toMatchObject({ count: 3, binding: 'memory' })
  })

  it('binds on maxPods', () => {
    // 25 tiny pods: cpu 250 / 2250 → 1, memory 0.25 GB / 4.5 → 1, pods 25 / 10 → 3
    const r = cluster('np-maxpods', [{ cpu: 10, memGB: 0.01, replicas: 25 }])
    expect(poolOf(r, 'np-maxpods')).toMatchObject({ count: 3, binding: 'maxPods' })
  })

  it('binds on min', () => {
    const r = cluster('np-min', [{ cpu: 500, memGB: 0.5, replicas: 1 }], { min: 4 })
    expect(poolOf(r, 'np-min')).toMatchObject({ count: 4, min: 4, binding: 'min' })
  })

  it('sums requests across all pod groups on the pool', () => {
    // 6 + 4 pods × 500 millicore = 5000 → 3 nodes (each group alone would fit in 2)
    const r = cluster('np-sum', [
      { cpu: 500, memGB: 0.5, replicas: 6 },
      { cpu: 500, memGB: 0.5, replicas: 4 },
    ])
    expect(poolOf(r, 'np-sum')).toMatchObject({ count: 3, binding: 'cpu' })
    expect(poolOf(r, 'np-sum-pods0')).toMatchObject({ count: 6, binding: 'min', nodePool: 'np-sum' })
    expect(poolOf(r, 'np-sum-pods1')).toMatchObject({ count: 4, binding: 'min', nodePool: 'np-sum' })
  })
})
