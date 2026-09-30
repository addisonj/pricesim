import { describe, expect, it } from 'vitest'
import { baseUnit, defineUnit, parseQuantity, q, u, UnitError, type Expr } from '../src/index.ts'
import { expectTypeOf } from 'vitest'

describe('custom base units', () => {
  const stream = baseUnit('stream')
  const partition = baseUnit('partition')

  it('compose with built-ins and each other, typed by name', () => {
    const total = q(10_000, stream.div(partition)).mul(q(24, partition))
    expectTypeOf(total).toEqualTypeOf<Expr<{ stream: 1 }>>()
    expect(total.in(stream)).toBe(240_000)
    const perHour = q(3600, stream.div(u.hour))
    expect(perHour.in(stream.div(u.s))).toBe(1)
  })

  it('are recognized at runtime by name, from any module', () => {
    expect(baseUnit('stream')).toBe(stream)
    expect(parseQuantity('5 stream/s').as(stream.div(u.s)).eval()).toBe(5)
    expect(() => parseQuantity('5 stream').as(partition)).toThrow(UnitError)
  })

  it('reject mismatches at runtime (and at compile time)', () => {
    // @ts-expect-error stream + partition
    expect(() => q(1, stream).add(q(1, partition))).toThrow(/stream vs partition/)
  })

  it('support scaled names and reject built-in or malformed names', () => {
    const kstream = defineUnit('kstream', stream, 1000)
    expect(q(2, kstream).in(stream)).toBe(2000)
    expect(parseQuantity('3 kstream').as(stream).eval()).toBe(3000)
    expect(() => baseUnit('byte')).toThrow(/built-in/)
    expect(() => baseUnit('GB')).toThrow(/built-in/)
    expect(() => baseUnit('two words')).toThrow(/invalid name/)
    expect(() => parseQuantity('1 widget')).toThrow(/baseUnit\/defineUnit first/)
  })
})
