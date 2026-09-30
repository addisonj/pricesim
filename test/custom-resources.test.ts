// Custom capacity resources: capacity set by software configuration (streams, partitions, appends/s) rather
// than by the instance type.
import { describe, expect, it } from 'vitest'
import {
  closedForm,
  dimension,
  evaluate,
  gauge,
  instancePool,
  pods,
  nodePool,
  pricing,
  q,
  request,
  scenario,
  series,
  service,
  u,
  workload,
  type Expr,
  type InstanceType,
} from '../src/index.ts'
import { baseUnit } from '../src/index.ts'

const stream = baseUnit('stream')

const H = 730
const vm: InstanceType = {
  id: 'cr-vm',
  capacity: { cpu: q(8, u.vCPU), memory: q(32, u.GiB), network: q(10, u.Gbps) },
  price: dimension('cr.vm.hours', u.hour, 1),
}
const perSecond = u.op.div(u.s)

// 3 partitions per core × 8 cores × 10k streams per partition, stored with 3 replicas → 80k streams per node
const STREAMS_PER_NODE = (3 * 8 * 10_000) / 3
const partition = baseUnit('partition')
const make = (streams: number, appends: number) => {
  const nodes = instancePool('cr-nodes', {
    instance: vm,
    min: 3,
    loadFactor: 1,
    azs: 3,
  })
  const svc = service('store', {
    pools: { nodes },
    // software capacity derived from the node's hardware: partitions from cores, streams from partitions
    capacity: {
      nodes: (hw) => {
        const partitions = hw.cpu.mul(q(3, partition.div(u.vCPU)))
        return {
          streams: partitions.mul(q(10_000 / 3, stream.div(partition))),
          appends: q(1e6, perSecond),
        }
      },
    },
    gauges: { streams: gauge(stream) },
    requests: ({ pools }) => ({
      append: request({}, () => ({ use: [pools.nodes.use('appends', q(1, u.op))] })),
    }),
    gaugeUse: (g, { pools }) => [pools.nodes.hold('streams', g.streams)],
  })
  return scenario({
    name: 'cr',
    root: svc,
    pricing: pricing(),
    workload: workload(svc, {
      requests: { append: { rate: series.constant(q(appends, u.req.div(u.s))), attrs: {} } },
      gauges: { streams: q(streams, stream) },
    }),
  })
}

describe('custom resources', () => {
  it('sizes a pool on a custom level resource (streams)', () => {
    const r = evaluate(make(1_000_000, 1000))
    const p = r.pools[0]!
    expect(p.count).toBe(Math.ceil(1_000_000 / STREAMS_PER_NODE)) // 12.5 → 13
    expect(p.binding).toBe('streams')
    expect(p.resources.streams!.capacity).toBe(13 * STREAMS_PER_NODE)
  })

  it('sizes a pool on a custom rate resource (appends/s)', () => {
    const r = evaluate(make(10_000, 5_500_000))
    expect(r.pools[0]).toMatchObject({ count: 6, binding: 'appends' })
  })

  it('attributes pool cost to streams by dominant share — a price per stream', () => {
    const r = evaluate(make(1_000_000, 1000))
    // 13 nodes × 730 h × $1; streams use 1M / (13 × 80k) of the pool's stream capacity-seconds
    const gaugeLine = r.tree.children![0]!.children!.find((c) => c.name === 'gauges')!
    expect(gaugeLine.cost).toBeCloseTo((1_000_000 / STREAMS_PER_NODE) * H, 6)
    expect(gaugeLine.cost / 1_000_000).toBeCloseTo(H / STREAMS_PER_NODE, 9) // $/stream-month
  })

  it('keeps closed forms exact', () => {
    const s = make(1_000_000, 1000)
    expect(closedForm(s).value).toBeCloseTo(evaluate(s).total, 6)
  })

  it('checks declaration and units', () => {
    const bad = (use: 'undeclared' | 'units') => {
      const nodes = instancePool('cr-bad', {
        instance: vm,
        min: 1,
        loadFactor: 1,
        azs: 1,
      })
      const svc = service('bad', {
        pools: { nodes },
        capacity: { nodes: () => ({ streams: q(10, stream) }) },
        requests: ({ pools }) => ({
          go: request({}, () => ({
            use: [
              use === 'undeclared'
                ? pools.nodes.use('partitions', q(1, u.op))
                : pools.nodes.use('streams', q(1, stream)),
            ],
          })),
        }),
      })
      return () =>
        evaluate(
          scenario({
            name: 'bad',
            root: svc,
            pricing: pricing(),
            workload: workload(svc, { requests: { go: { rate: series.constant(q(1, u.req.div(u.s))), attrs: {} } } }),
          }),
        )
    }
    expect(bad('undeclared')).toThrow(/declares no custom resource 'partitions'/)
    // a per-request 'streams' demand is streams/s, but capacity is in streams (a level): use hold() instead
    expect(bad('units')).toThrow(
      /has capacity in stream but the per-request demand per second is s\^-1\*stream|stream\*s\^-1/,
    )
  })

  it('works on pods (sizes replicas)', () => {
    const np = nodePool('cr-np', {
      instance: vm,
      min: 1,
      azs: 1,
      reserved: { cpu: q(0, u.millicore), memory: q(0, u.GiB) },
      maxPods: 100,
      packingEfficiency: 1,
    })
    const svc = service('podsvc', {
      pools: {
        p: pods('cr-pods', {
          on: np,
          request: { cpu: q(100, u.millicore), memory: q(1, u.GiB) },
          minReplicas: 1,
          targetUtilization: 1,
        }),
      },
      capacity: { p: () => ({ streams: q(1000, stream) }) },
      gauges: { streams: gauge(stream) },
      requests: () => ({}),
      gaugeUse: (g, { pools }) => [pools.p.hold('streams', g.streams)],
    })
    const r = evaluate(
      scenario({
        name: 'pods',
        root: svc,
        pricing: pricing(),
        workload: workload(svc, { requests: {}, gauges: { streams: q(4500, stream) } }),
      }),
    )
    expect(r.pools.find((p) => p.name === 'cr-pods')).toMatchObject({ count: 5, binding: 'streams' })
  })
})

describe('service-declared capacity', () => {
  const partition = baseUnit('partition')
  const mk = (name: string, cores: number) =>
    instancePool(name, {
      instance: { ...vm, id: `${name}-vm`, capacity: { ...vm.capacity, cpu: q(cores, u.vCPU) } },
      min: 1,
      loadFactor: 1,
      azs: 1,
    })

  it('scales with the instance: 16 cores give twice the partitions of 8', () => {
    const derive = {
      nodes: (hw: { cpu: Expr<{ millicore: 1 }> }) => ({ partitions: hw.cpu.mul(q(3, partition.div(u.vCPU))) }),
    }
    const p8 = mk('sd-8', 8)
    const p16 = mk('sd-16', 16)
    service('sd-a', { pools: { nodes: p8 }, capacity: derive, requests: () => ({}) })
    service('sd-b', { pools: { nodes: p16 }, capacity: derive, requests: () => ({}) })
    expect(p8.customCapacity('partitions')!.in(partition)).toBe(24)
    expect(p16.customCapacity('partitions')!.in(partition)).toBe(48)
  })

  it('rejects conflicting declarations, built-in names and unknown pools', () => {
    const p = mk('sd-shared', 8)
    service('sd-owner', {
      pools: { nodes: p },
      capacity: { nodes: () => ({ streams: q(1, stream) }) },
      requests: () => ({}),
    })
    expect(() =>
      service('sd-other', {
        pools: { nodes: p },
        capacity: { nodes: () => ({ streams: q(2, stream) }) },
        requests: () => ({}),
      }),
    ).toThrow(/already has capacity 'streams' declared by sd-owner/)
    expect(() =>
      service('sd-builtin', {
        pools: { nodes: mk('sd-b2', 8) },
        capacity: { nodes: (hw) => ({ cpu: hw.cpu }) },
        requests: () => ({}),
      }),
    ).toThrow(/built-in resource/)
    expect(() =>
      service('sd-unknown', { pools: {}, capacity: { nodes: () => ({}) } as never, requests: () => ({}) }),
    ).toThrow(/unknown pool 'nodes'/)
  })
})
