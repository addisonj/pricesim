// Capacity resources beyond cpu/memory/network (PLAN 1.7): EBS bandwidth, EBS IOPS and disk on instance
// pools, optional pod network requests, and errors for demand on resources a sink doesn't declare.
import { describe, expect, it } from 'vitest'
import {
  edge,
  evaluate,
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
  type InstanceType,
} from '../../src/index.ts'
import { dimOf, instanceType, list, poolOf, rps, transferDim } from './fixtures.ts'

describe('instance pools: EBS and disk resources', () => {
  // 1000 millicore, 1 GB, 1e6 byte/s network; EBS 1e6 byte/s and 1000 op/s; 100 GB local NVMe; $1/h
  const disky = instanceType('res-disky', { ebsBytesPerSecond: 1e6, ebsIops: 1000, nvmeGB: 100 })
  /**
   *   io:     10 EBS ops per request       → rate × 10 op/s
   *   scan:   100 KB of EBS I/O per request → rate × 1e5 byte/s
   *   files:  1 GB of disk per file (gauge)
   */
  const svc = (name: string, instance: InstanceType) =>
    service(name, {
      pools: { vms: instancePool(name, { instance, min: 1, loadFactor: 0.5, azs: 1 }) },
      gauges: { files: gauge(u.count) },
      requests: ({ pools }) => ({
        io: request({}, () => ({ use: [pools.vms.ebsIops(q(10, u.op))] })),
        scan: request({}, () => ({ use: [pools.vms.ebsBandwidth(q(100, u.KB))] })),
      }),
      gaugeUse: (g, { pools }) => [pools.vms.disk(g.files.mul(q(1, u.GB.div(u.count))))],
    })
  const run = (name: string, load: { io?: number; scan?: number; files?: number }, instance = disky) => {
    const s = svc(name, instance)
    const w = workload(s, {
      requests: {
        ...(load.io ? { io: { rate: rps(load.io), attrs: {} } } : {}),
        ...(load.scan ? { scan: { rate: rps(load.scan), attrs: {} } } : {}),
      },
      gauges: { files: q(load.files ?? 0, u.count) },
    })
    return evaluate(scenario({ name, root: s, workload: w, pricing: list }))
  }

  it('binds on EBS IOPS', () => {
    // 200 req/s × 10 op = 2000 op/s; / (1000 × 0.5) = 4 instances
    const p = poolOf(run('res-iops', { io: 200 }), 'res-iops')
    expect(p).toMatchObject({ count: 4, binding: 'ebsIops' })
    expect(p.resources.ebsIops).toEqual({ peak: 2000, mean: 2000, capacity: 4000 })
  })

  it('binds on EBS bandwidth', () => {
    // 30 req/s × 100 KB = 3e6 byte/s; / (1e6 × 0.5) = 6 instances
    const p = poolOf(run('res-ebsbw', { scan: 30 }), 'res-ebsbw')
    expect(p).toMatchObject({ count: 6, binding: 'ebsBandwidth' })
    expect(p.resources.ebsBandwidth!.peak).toBeCloseTo(3e6, 6)
    expect(p.resources.ebsBandwidth!.capacity).toBe(6e6)
  })

  it('binds on disk held by gauges (local NVMe)', () => {
    // 150 files × 1 GB = 150 GB; / (100 GB × 0.5) = 3 instances
    const p = poolOf(run('res-disk', { files: 150 }), 'res-disk')
    expect(p).toMatchObject({ count: 3, binding: 'disk' })
    expect(p.resources.disk).toEqual({ peak: 150e9, mean: 150e9, capacity: 300e9 })
  })

  it('reports only the resources the instance type declares', () => {
    const p = poolOf(run('res-report', {}, instanceType('res-plain')), 'res-report')
    expect(Object.keys(p.resources).sort()).toEqual(['cpu', 'memory', 'network'])
    expect(Object.keys(poolOf(run('res-report2', {}), 'res-report2').resources).sort()).toEqual(
      ['cpu', 'disk', 'ebsBandwidth', 'ebsIops', 'memory', 'network'].sort(),
    )
  })

  it('rejects demand on a resource the instance type does not declare', () => {
    const plain = instanceType('res-undeclared')
    expect(() => run('res-no-iops', { io: 1 }, plain)).toThrow(
      "pool 'res-no-iops' has demand on ebsIops, but neither instance type res-undeclared nor the pool declares ebsIops capacity",
    )
    expect(() => run('res-no-disk', { files: 1 }, plain)).toThrow(/demand on disk/)
    // declaring the use without any demand is fine
    expect(poolOf(run('res-zero', {}, plain), 'res-zero')).toMatchObject({ count: 1, binding: 'min' })
  })
})

describe('pods: network requests', () => {
  // node: 64 cores, 256 GB, 1e7 byte/s network, no reservation, perfect packing
  const node = instanceType('res-net-node', { millicores: 64_000, memoryGB: 256, bytesPerSecond: 1e7 })
  const np = (name: string) =>
    nodePool(name, {
      instance: node,
      min: 1,
      azs: 1,
      reserved: { cpu: q(0, u.millicore), memory: q(0, u.GB) },
      maxPods: 100,
      packingEfficiency: 1,
    })
  const svc = (name: string, network?: number) =>
    service(name, {
      pools: {
        p: pods(name, {
          on: np(`${name}-nodes`),
          request: {
            cpu: q(100, u.millicore),
            memory: q(0.1, u.GB),
            ...(network !== undefined ? { network: q(network, u.byte.div(u.s)) } : {}),
          },
          minReplicas: 1,
          targetUtilization: 0.5,
        }),
      },
      requests: ({ pools }) => ({ send: request({}, () => ({ use: [pools.p.network(q(100, u.KB))] })) }),
    })
  const run = (name: string, rate: number, network?: number) => {
    const s = svc(name, network)
    const w = workload(s, { requests: { send: { rate: rps(rate), attrs: {} } } })
    return evaluate(scenario({ name, root: s, workload: w, pricing: list }))
  }

  it('sizes replicas and nodes on network when the pod requests it', () => {
    // demand 300 req/s × 100 KB = 3e7 byte/s; pod request 2e6 byte/s × 0.5 → 30 replicas (binding network;
    // cpu has no demand). Nodes: 30 × 2e6 = 6e7 byte/s / (1e7 × 1) = 6 nodes, network binds
    // (cpu 30 × 100 = 3000 / 64000 → 1; pods 30 / 100 → 1)
    const r = run('res-podnet', 300, 2e6)
    expect(poolOf(r, 'res-podnet')).toMatchObject({ count: 30, binding: 'network' })
    expect(poolOf(r, 'res-podnet').resources.network!.capacity).toBe(6e7)
    const nodes = poolOf(r, 'res-podnet-nodes')
    expect(nodes).toMatchObject({ count: 6, binding: 'network' })
    expect(nodes.resources.network).toEqual({ peak: 6e7, mean: 6e7, capacity: 6e7 })
  })

  it('rejects network demand on pods that do not request network', () => {
    expect(() => run('res-podnet-missing', 1)).toThrow(
      "pods 'res-podnet-missing' has demand on network, but the pod request declares no network",
    )
  })
})

describe('network edges add demand to the pools at their ends', () => {
  // 1e6 byte/s network per instance, loadFactor 0.5 → 5e5 byte/s usable per instance
  const vm = instanceType('res-edge-vm')
  const make = (name: string, ends: boolean) => {
    const backVms = instancePool(`${name}-back`, { instance: vm, min: 1, loadFactor: 0.5, azs: 3 })
    const back = service(`${name}-back`, { pools: { vms: backVms }, requests: () => ({}) })
    const front = service(`${name}-front`, {
      deps: { back },
      pools: { vms: instancePool(`${name}-front`, { instance: vm, min: 1, loadFactor: 0.5, azs: 3 }) },
      requests: ({ pools }) => ({
        // 100 KB front → back per request, 2/3 of it crossing AZs
        call: request({}, () => ({
          net: [edge(q(100, u.KB), { kind: 'uniformClients', azs: 3 }, ends ? { from: pools.vms, to: backVms } : {})],
        })),
      }),
    })
    const w = workload(front, { requests: { call: { rate: rps(20), attrs: {} } } })
    return evaluate(scenario({ name, root: front, workload: w, pricing: list, interAz: transferDim() }))
  }

  it('adds the edge bytes as network demand on both ends', () => {
    // 20 req/s × 100 KB = 2e6 byte/s at each end / 5e5 → 4 instances each, network binds
    const r = make('res-edge', true)
    expect(poolOf(r, 'res-edge-front')).toMatchObject({ count: 4, binding: 'network' })
    expect(poolOf(r, 'res-edge-back')).toMatchObject({ count: 4, binding: 'network' })
    expect(poolOf(r, 'res-edge-back').resources.network!.peak).toBeCloseTo(2e6, 6)
  })

  it('adds no demand without ends, and bills the same transfer either way', () => {
    const r = make('res-edge-bill', false)
    expect(poolOf(r, 'res-edge-bill-front')).toMatchObject({ count: 1, binding: 'min' })
    expect(poolOf(r, 'res-edge-bill-back').resources.network!.peak).toBe(0)
    // 20 req/s × 100 KB × 2/3 crossing × 2 directions × 1 month, in GB
    const gb = (20 * 100e3 * (2 / 3) * 2 * 2_628_000) / 1e9
    const t = 't.transfer.inter-az'
    expect(dimOf(r, t).usage).toBeCloseTo(gb, 6)
    expect(dimOf(make('res-edge-bill2', true), t).usage).toBeCloseTo(gb, 6)
  })
})
