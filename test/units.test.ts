import { describe, expect, it } from 'vitest'
import { ceil, max, opaque, param, parseQuantity, q, sym, u, UnitError } from '../src/index.ts'

describe('units', () => {
  it('converts between compatible units', () => {
    expect(q(1, u.GiB).in(u.MiB)).toBe(1024)
    expect(q(1, u.month).in(u.hour)).toBe(730)
    expect(q(1, u.Gbps).in(u.MB.div(u.s))).toBeCloseTo(125)
    expect(q(2, u.vCPU).in(u.millicore)).toBe(2000)
  })

  it('prices storage: USD/(GB*month) × TiB × month → USD', () => {
    const price = q(0.16, u.USD.div(u.GB.mul(u.month)))
    const cost = price.mul(q(4, u.TiB)).mul(q(1, u.month))
    expect(cost.in(u.USD)).toBeCloseTo((0.16 * (4 * 1024 ** 4)) / 1e9, 6)
  })

  it('rejects mismatched dimensions at runtime', () => {
    const bad = q(2, u.GB) as any
    expect(() => bad.add(q(1, u.GB.div(u.s)))).toThrow(UnitError)
    expect(() => bad.add(q(1, u.GB.div(u.s)))).toThrow(/byte vs s\^-1\*byte|byte vs byte\*s\^-1|unit mismatch/)
  })

  it('parses quantities at untyped boundaries and narrows with as()', () => {
    const rate = parseQuantity('5000 req/s').as(u.req.div(u.s))
    expect(rate.in(u.req.div(u.minute))).toBe(300_000)
    expect(
      parseQuantity('0.16 USD/(GB*month)')
        .as(u.USD.div(u.GB.mul(u.month)))
        .eval(),
    ).toBeCloseTo(0.16 / 1e9 / (730 * 3600))
    expect(() => parseQuantity('5 GB').as(u.req.div(u.s))).toThrow(UnitError)
    expect(() => parseQuantity('5 furlongs')).toThrow(/unknown unit/)
  })
})

describe('expressions', () => {
  it('evaluates a sizing relation with symbols, params, max and ceil', () => {
    const rate = sym('rate', u.req.div(u.s))
    const cpuPerReq = q(50, u.millicore.mul(u.ms).div(u.req))
    const load = param('load', q(0.6, u.one))
    const perNode = q(8000, u.millicore.div(u.count))
    const nodes = max(q(3, u.count), ceil(rate.mul(cpuPerReq).div(perNode.mul(load))))

    // 10k req/s × 50 millicore·ms = 500,000 millicore·ms/s = 500 millicore → 500/(8000×0.6) → ceil 1 → min 3
    expect(nodes.in(u.count, { rate: 10_000 })).toBe(3)
    // 1M req/s → 50,000 millicore / 4,800 → 10.4 → 11
    expect(nodes.in(u.count, { rate: 1_000_000 })).toBe(11)
    // params can be overridden
    expect(nodes.in(u.count, { rate: 1_000_000, load: 1 })).toBe(7)
  })

  it('supports number overloads for dimensionless factors', () => {
    expect(q(1, u.GB).mul(3).in(u.GB)).toBe(3)
    expect(q(9, u.GB).div(3).in(u.GB)).toBe(3)
  })

  it('evaluates opaque functions in declared units', () => {
    const rate = sym('rate', u.req.div(u.s))
    const p99 = opaque('p99', { inputs: { rate }, unit: u.ms }, ({ rate }) => rate / 1000)
    expect(p99.in(u.ms, { rate: 5000 })).toBe(5)
    expect(p99.add(q(5, u.ms)).in(u.ms, { rate: 5000 })).toBe(10)
  })

  it('throws on unbound symbols', () => {
    expect(() => sym('x', u.byte).eval()).toThrow(/unbound symbol 'x'/)
  })
})
