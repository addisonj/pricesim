// EBS gp3 volumes attached to pools (PLAN 1.3): rates, per-instance billing split like instance-hours,
// capacity from volumes (capped by instance EBS limits), node pools, validation and closed form.
import { describe, expect, it } from 'vitest'
import { ebsRates, gp3 } from '../src/catalog/aws/index.ts'
import {
  closedForm,
  dimension,
  nodeCapacity,
  pricing,
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
  type InstancePoolSpec,
  type InstanceType,
} from '../src/index.ts'
import { cpuS, dimOf, H, instanceType, list, nodeAt, poolOf, rps } from './engine/fixtures.ts'

const MiBps = u.MiB.div(u.s)
const iops = u.op.div(u.s)

describe('gp3 rates (us-east-1, meteredUnitMaps/ec2/ebs.json)', () => {
  it('bills $0.08/GB-month, $0.005/IOPS-month above 3,000, $0.04/MiB/s-month above 125', () => {
    expect(ebsRates.gp3Storage.schedule).toEqual({ kind: 'flat', rate: 0.08 })
    expect(ebsRates.gp3Iops.schedule).toEqual({ kind: 'flat', rate: 0.005 })
    expect(ebsRates.gp3Throughput.schedule).toEqual({ kind: 'flat', rate: 0.04 })
    // usage units: GiB-month, (op/s)-month, (MiB/s)-month
    expect(ebsRates.gp3Storage.usageUnit.scale).toBe(1024 ** 3 * 730 * 3600)
    expect(ebsRates.gp3Iops.usageUnit.scale).toBe(730 * 3600)
    expect(ebsRates.gp3Throughput.usageUnit.scale).toBe(1024 ** 2 * 730 * 3600)
  })

  it('includes 3,000 IOPS and 125 MiB/s, and rejects specs gp3 does not allow', () => {
    const v = gp3.provision({ size: 100 * 1024 ** 3 })
    expect(v).toMatchObject({ iops: 3000, throughput: 125 * 1024 ** 2 })
    expect(v.usage.map((x) => x.perSecond)).toEqual([100 * 1024 ** 3, 0, 0])
    const GiB = 1024 ** 3
    expect(() => gp3.provision({ size: 100 * GiB, iops: 2000 })).toThrow(/2000 IOPS is outside 3,000 – 50000/)
    // 500 IOPS per GiB: 10 GiB allows at most 5,000
    expect(() => gp3.provision({ size: 10 * GiB, iops: 6000 })).toThrow(/outside 3,000 – 5000/)
    // 0.25 MiB/s per IOPS: 3,000 IOPS allow at most 750 MiB/s
    expect(() => gp3.provision({ size: 100 * GiB, throughput: 1000 * 1024 ** 2 })).toThrow(/outside 125 – 750 MiB/)
    expect(() => gp3.provision({ size: 0.5 * GiB })).toThrow(/size 0.5 GiB/)
  })
})

describe('volumes on instance pools', () => {
  // 1000 millicore, 1 GB, $1/h; EBS limits 2000 op/s and 1e8 byte/s
  const vm = instanceType('ebs-vm', { ebsIops: 2000, ebsBytesPerSecond: 1e8 })
  // 100 GiB gp3 with 4,000 IOPS and 250 MiB/s: per volume-month 100 × $0.08 + 1,000 × $0.005 + 125 × $0.04
  // = $8 + $5 + $5 = $18
  const volume = { type: gp3, size: q(100, u.GiB), iops: q(4000, iops), throughput: q(250, MiBps) }
  const run = (
    name: string,
    load: { cpu?: number; io?: number; diskGiB?: number },
    spec: Partial<InstancePoolSpec> = {},
    instance: InstanceType = vm,
  ) => {
    const svc = service(name, {
      pools: { vms: instancePool(name, { instance, min: 1, loadFactor: 0.5, azs: 1, volumes: [volume], ...spec }) },
      gauges: { gib: gauge(u.count) },
      requests: ({ pools }) => ({
        work: request({}, () => ({ use: [pools.vms.cpu(q(250, cpuS))] })),
        io: request({}, () => ({ use: [pools.vms.ebsIops(q(100, u.op))] })),
      }),
      gaugeUse: (g, { pools }) => [pools.vms.disk(g.gib.mul(q(1, u.GiB.div(u.count))))],
    })
    const w = workload(svc, {
      requests: {
        ...(load.cpu ? { work: { rate: rps(load.cpu), attrs: {} } } : {}),
        ...(load.io ? { io: { rate: rps(load.io), attrs: {} } } : {}),
      },
      gauges: { gib: q(load.diskGiB ?? 0, u.count) },
    })
    return scenario({ name, root: svc, workload: w, pricing: list })
  }

  it('bills one volume per instance', () => {
    // 2 instances (min 2): volumes 2 × $18 = $36; instances 2 × $730
    const r = evaluate(run('ebs-bill', {}, { min: 2 }))
    expect(dimOf(r, 'aws.ebs.gp3.storage').cost).toBeCloseTo(16, 9)
    expect(dimOf(r, 'aws.ebs.gp3.iops').cost).toBeCloseTo(10, 9)
    expect(dimOf(r, 'aws.ebs.gp3.throughput').cost).toBeCloseTo(10, 9)
    expect(r.total).toBeCloseTo(2 * H + 36, 9)
  })

  it('splits volume cost between used and idle like the instance-hours', () => {
    // 1 req/s × 250 millicore·s = 250 millicore → 1 instance; the request's share is 250 / 1000 = 0.25:
    //   used: 0.25 × ($730 + $18) = $187      idle headroom: 0.75 × $748 = $561
    const r = evaluate(run('ebs-split', { cpu: 1 }))
    expect(nodeAt(r.tree, ['ebs-split', 'work', 'ebs-split']).cost).toBeCloseTo(187, 9)
    expect(nodeAt(r.tree, ['idle', 'ebs-split', 'headroom']).cost).toBeCloseTo(561, 9)
    expect(r.used).toBeCloseTo(187, 9)
    expect(r.total).toBeCloseTo(748, 9)
  })

  it('adds the volume size as disk capacity', () => {
    // 150 GiB held / (100 GiB × 0.5) = 3 instances, disk binds
    const p = poolOf(evaluate(run('ebs-disk', { diskGiB: 150 })), 'ebs-disk')
    expect(p).toMatchObject({ count: 3, binding: 'disk' })
    expect(p.resources.disk!.capacity).toBe(300 * 1024 ** 3)
  })

  it('caps the volume IOPS at the instance EBS limit', () => {
    // capacity min(2000 instance, 4000 volume) = 2000 op/s; 30 req/s × 100 op = 3000 op/s / 1000 → 3
    const p = poolOf(evaluate(run('ebs-iops', { io: 30 })), 'ebs-iops')
    expect(p).toMatchObject({ count: 3, binding: 'ebsIops' })
    expect(p.resources.ebsIops!.capacity).toBe(6000)
    expect(p.resources.ebsBandwidth!.capacity).toBe(3 * 1e8) // min(1e8, 250 MiB/s = 2.62e8)
  })

  it("uses the volume's IOPS when the instance has no EBS limit", () => {
    // plain instance: 4000 op/s from the volume; 30 req/s × 100 = 3000 / 2000 → 2 instances
    const p = poolOf(evaluate(run('ebs-iops-vol', { io: 30 }, {}, instanceType('ebs-plain'))), 'ebs-iops-vol')
    expect(p).toMatchObject({ count: 2, binding: 'ebsIops' })
    expect(p.resources.ebsIops!.capacity).toBe(8000)
  })

  it('closed form includes the volume cost per instance', () => {
    const s = run('ebs-cf', { cpu: 10 })
    // 10 × 250 = 2500 millicore / 500 → 5 instances × $748
    expect(closedForm(s).value).toBeCloseTo(evaluate(s).total, 9)
    expect(closedForm(s).value).toBeCloseTo(5 * 748, 9)
    // relaxed: 250 / 500 = 0.5 instance per req/s × $748
    expect(closedForm(s, { mode: 'relaxed' }).linear!.perUnit['rate_work']).toBeCloseTo(0.5 * 748, 9)
  })
})

describe('volumes on node pools', () => {
  it('bills one volume per node, split like the node-hours', () => {
    // 3 nodes (min) with a 20 GiB gp3 root volume: 3 × 20 × $0.08 = $4.80. Node: 4000 millicore, 8 GB, no
    // reservation; one pod group of 2 × 1000 millicore → requests 2 × 0.25 = 0.5 node; no load.
    //   pod headroom 0.5 × ($730 + $1.60) = $365.80; node slack 2.5 × $731.60 = $1829
    const node = instanceType('ebs-node', { millicores: 4000, memoryGB: 8 })
    const np = nodePool('ebs-nodes', {
      instance: node,
      min: 3,
      azs: 3,
      reserved: { cpu: q(0, u.millicore), memory: q(0, u.GB) },
      maxPods: 10,
      packingEfficiency: 1,
      volumes: [{ type: gp3, size: q(20, u.GiB) }],
    })
    const svc = service('ebs-np', {
      pools: {
        p: pods('ebs-np', {
          on: np,
          request: { cpu: q(1000, u.millicore), memory: q(1, u.GB) },
          minReplicas: 2,
          targetUtilization: 1,
        }),
      },
      requests: () => ({}),
    })
    const s = scenario({ name: 'ebs-np', root: svc, workload: workload(svc, { requests: {} }), pricing: list })
    const r = evaluate(s)
    expect(dimOf(r, 'aws.ebs.gp3.storage').cost).toBeCloseTo(4.8, 9)
    expect(r.dimensions.map((d) => d.id)).not.toContain('aws.ebs.gp3.iops') // baseline IOPS are free
    expect(nodeAt(r.tree, ['idle', 'ebs-nodes', 'pod headroom: ebs-np']).cost).toBeCloseTo(365.8, 9)
    expect(nodeAt(r.tree, ['idle', 'ebs-nodes', 'node slack']).cost).toBeCloseTo(1829, 9)
    expect(r.total).toBeCloseTo(3 * 731.6, 9)
    expect(closedForm(s).value).toBeCloseTo(r.total, 9)
  })
})

describe('multiple volumes per instance', () => {
  it('sums disk, IOPS and throughput across volumes (capped by the instance) and bills each', () => {
    const vm: InstanceType = {
      id: 'mv-vm',
      capacity: {
        cpu: q(8, u.vCPU),
        memory: q(32, u.GiB),
        network: q(10, u.Gbps),
        ebsBandwidth: q(1250, u.MB.div(u.s)),
      },
      price: dimension('mv.vm.hours', u.hour, 0),
    }
    const pool = instancePool('mv-pool', {
      instance: vm,
      min: 2,
      loadFactor: 1,
      azs: 1,
      volumes: [
        { type: gp3, size: q(1000, u.GiB), count: 4 },
        { type: gp3, size: q(50, u.GiB) },
      ],
    })
    const cap = nodeCapacity(vm, {}, pool.spec.volumes)
    expect(cap.disk).toBe(4050 * 1024 ** 3)
    // 5 × 125 MiB/s = 625 MiB/s < 1250 MB/s instance limit
    expect(cap.ebsBandwidth).toBeCloseTo(5 * 125 * 1024 ** 2, 0)
    expect(cap.ebsIops).toBe(5 * 3000)
    const svc = service('mv', { pools: { p: pool }, requests: () => ({}) })
    const r = evaluate(
      scenario({ name: 'mv', root: svc, pricing: pricing(), workload: workload(svc, { requests: {} }) }),
    )
    // 2 instances × 4,050 GiB × $0.08 per GiB-month
    expect(r.total).toBeCloseTo(2 * 4050 * 0.08, 6)
    expect(pool.hardware().disk!.in(u.GiB)).toBe(4050)
  })
})
