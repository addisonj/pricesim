// Closed-form capacity terms for the resources beyond cpu/memory (PLAN 1.7): exact mode takes the max over
// every declared resource, relaxed mode sizes on the binding one.
import { describe, expect, it } from 'vitest'
import {
  closedForm,
  evaluate,
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
import { H, instanceType, list, rps } from './fixtures.ts'

describe('closed form: EBS IOPS-bound instance pool', () => {
  // 1000 op/s EBS per instance, loadFactor 0.5, $1/h; 10 EBS ops per request
  const vm = instanceType('cf-iops', { ebsIops: 1000 })
  const svc = service('cf-iops', {
    pools: { vms: instancePool('cf-iops', { instance: vm, min: 1, loadFactor: 0.5, azs: 1 }) },
    requests: ({ pools }) => ({ io: request({}, () => ({ use: [pools.vms.ebsIops(q(10, u.op))] })) }),
  })
  const s = scenario({
    name: 'cf-iops',
    root: svc,
    workload: workload(svc, { requests: { io: { rate: rps(200), attrs: {} } } }),
    pricing: list,
  })

  it('exact mode reproduces the numeric total', () => {
    // 200 × 10 = 2000 op/s / 500 → 4 instances × $730
    expect(evaluate(s).total).toBeCloseTo(4 * H, 9)
    expect(closedForm(s).value).toBeCloseTo(4 * H, 9)
  })

  it('relaxed mode sizes on EBS IOPS: 10 op / 500 op/s per instance = 0.02 instance per req/s', () => {
    const cf = closedForm(s, { mode: 'relaxed' })
    expect(cf.linear!.constant).toBeCloseTo(0, 9)
    expect(cf.linear!.perUnit['rate_io']).toBeCloseTo(0.02 * H, 9)
  })
})

describe('closed form: network-bound pods', () => {
  // node: 1e7 byte/s, no reservation, perfect packing; pods request 2e6 byte/s at 50%; 100 KB per request
  const node = instanceType('cf-podnet-node', { millicores: 64_000, memoryGB: 256, bytesPerSecond: 1e7 })
  const np = nodePool('cf-podnet-nodes', {
    instance: node,
    min: 1,
    azs: 1,
    reserved: { cpu: q(0, u.millicore), memory: q(0, u.GB) },
    maxPods: 100,
    packingEfficiency: 1,
  })
  const svc = service('cf-podnet', {
    pools: {
      p: pods('cf-podnet', {
        on: np,
        request: { cpu: q(100, u.millicore), memory: q(0.1, u.GB), network: q(2e6, u.byte.div(u.s)) },
        minReplicas: 1,
        targetUtilization: 0.5,
      }),
    },
    requests: ({ pools }) => ({ send: request({}, () => ({ use: [pools.p.network(q(100, u.KB))] })) }),
  })
  const s = scenario({
    name: 'cf-podnet',
    root: svc,
    workload: workload(svc, { requests: { send: { rate: rps(300), attrs: {} } } }),
    pricing: list,
  })

  it('exact mode reproduces the numeric total (30 pods → 6 nodes)', () => {
    expect(closedForm(s).value).toBeCloseTo(evaluate(s).total, 9)
    expect(closedForm(s).value).toBeCloseTo(6 * H, 9)
  })

  it('relaxed: replicas = rate × 1e5 / 1e6, nodes = replicas × 2e6 / 1e7 → 0.02 node per req/s', () => {
    expect(closedForm(s, { mode: 'relaxed' }).linear!.perUnit['rate_send']).toBeCloseTo(0.02 * H, 9)
  })
})
