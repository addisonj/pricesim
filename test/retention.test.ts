// Time-varying retention: windows that fill then drop off, and data kept forever.
import { describe, expect, it } from 'vitest'
import {
  closedForm,
  dimension,
  evaluate,
  gauge,
  instancePool,
  pricing,
  q,
  request,
  retained,
  scenario,
  series,
  service,
  u,
  workload,
  type Expr,
  type InstanceType,
} from '../src/index.ts'

const H = 730
const T = H * 3600
const MB_S = 1e6 // 1 MB/s written
const storage = dimension('ret.storage', u.GB.mul(u.month), 0.1)
const vm: InstanceType = {
  id: 'ret-vm',
  capacity: { cpu: q(1, u.vCPU), memory: q(1, u.GiB), network: q(1, u.Gbps), nvme: { bytes: q(1, u.TB) } },
  price: dimension('ret.vm.hours', u.hour, 1),
}
const store = service('store', {
  pools: { disks: instancePool('ret-disks', { instance: vm, min: 1, loadFactor: 1, azs: 1 }) },
  gauges: { stored: gauge(u.byte, { billAs: storage }) },
  requests: () => ({ write: request({ bytes: u.byte }, () => ({})) }),
  gaugeUse: (g, { pools }) => [pools.disks.disk(g.stored)],
})
const run = (stored: (rate: Expr<{ byte: 1; s: -1 }>) => Expr<any>) => {
  const s = scenario({
    name: 'ret',
    root: store,
    pricing: pricing(),
    workload: workload(store, {
      requests: { write: { rate: series.constant(q(1, u.req.div(u.s))), attrs: { bytes: q(1, u.MB) } } },
      gauges: ({ rate }) => ({ stored: stored(rate.write.mul(q(1, u.MB.div(u.req)))) as never }),
    }),
  })
  return { s, r: evaluate(s) }
}
/** mean over hourly midpoints of f(t) */
const meanOver = (f: (t: number) => number) => {
  let sum = 0
  for (let i = 0; i < H; i++) sum += f((i + 0.5) * 3600)
  return sum / H
}
const storageCost = (r: ReturnType<typeof evaluate>) => r.dimensions.find((d) => d.id === 'ret.storage')!.cost
const GB_MONTH = 0.1 / 1e9 // $ per byte-month

describe('retention', () => {
  it('a full window is constant: rate × retention', () => {
    const { r } = run((rate) => retained({ rate, retention: q(7, u.day) }))
    expect(storageCost(r)).toBeCloseTo(MB_S * 7 * 86400 * GB_MONTH, 6)
  })

  it('a fresh window fills, then data drops off as fast as it arrives', () => {
    const { r } = run((rate) => retained({ rate, retention: q(7, u.day), ageAtStart: q(0, u.day) }))
    const level = meanOver((t) => MB_S * Math.min(7 * 86400, t))
    expect(storageCost(r)).toBeCloseTo(level * GB_MONTH, 6)
  })

  it('data kept forever keeps growing: month 13 costs rate × (12 months + half a month)', () => {
    const { s, r } = run((rate) => retained({ rate, ageAtStart: q(12, u.month) }))
    expect(storageCost(r)).toBeCloseTo(MB_S * (12 * T + T / 2) * GB_MONTH, 6)
    // pools are sized on the end-of-period level: (12 months + 729.5 h) × 1 MB/s on 1 TB disks
    const endLevel = MB_S * (12 * T + (H - 0.5) * 3600)
    expect(r.pools[0]!.count).toBe(Math.ceil(endLevel / 1e12))
    // closed form evaluates time at mid-period: exact for the (linear) storage bill
    const cf = closedForm(s)
    expect(cf.assumptions.join(' ')).toMatch(/mid-period/)
  })

  it('without retention or age, data starts accumulating at the start of the period', () => {
    const { r } = run((rate) => retained({ rate }))
    expect(storageCost(r)).toBeCloseTo(MB_S * (T / 2) * GB_MONTH, 6)
  })
})
