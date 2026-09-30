// Compile-time dimension checks (run by vitest typecheck and `pnpm typecheck`).
import { expectTypeOf, test } from 'vitest'
import { ceil, dimension, instancePool, max, q, sym, u, type Expr } from '../src/index.ts'

test('derived dimensions are computed and simplified', () => {
  expectTypeOf(u.USD.div(u.GB.mul(u.month))).toEqualTypeOf<
    import('../src/index.ts').Unit<{ USD: 1; s: -1; byte: -1 }>
  >()
  const cost = q(0.16, u.USD.div(u.GB.mul(u.month)))
    .mul(q(4, u.TiB))
    .mul(q(1, u.month))
  expectTypeOf(cost).toEqualTypeOf<Expr<{ USD: 1 }>>()
  const cpu = sym('rate', u.req.div(u.s)).mul(q(50, u.millicore.mul(u.ms).div(u.req)))
  expectTypeOf(cpu).toEqualTypeOf<Expr<{ millicore: 1 }>>()
  expectTypeOf(max(q(3, u.count), ceil(cpu.div(q(8000, u.millicore.div(u.count)))))).toEqualTypeOf<Expr<{ count: 1 }>>()
})

test('mismatches are compile errors', () => {
  // @ts-expect-error GB + GB/s
  q(2, u.GB).add(q(1, u.GB.div(u.s)))
  // @ts-expect-error max(count, millicore)
  max(q(3, u.count), q(1, u.millicore))
  // @ts-expect-error extra exponents are not assignable (invariance)
  const _b: Expr<{ byte: 1 }> = q(1, u.GB.div(u.s))
  // @ts-expect-error converting to an incompatible unit
  q(1, u.GB).in(u.hour)
})

test('sink demands are unit-checked', () => {
  const vm = {
    id: 'vm',
    capacity: { cpu: q(1, u.vCPU), memory: q(1, u.GB), network: q(1, u.Gbps) },
    price: dimension('vm.hours', u.hour, 1),
  }
  const p = instancePool('p', { instance: vm, min: 1, loadFactor: 1, azs: 1 })
  p.ebsIops(q(10, u.op))
  p.ebsBandwidth(q(1, u.MB))
  p.disk(q(1, u.GB))
  // @ts-expect-error EBS IOPS demand is in ops per request
  p.ebsIops(q(1, u.GB))
  // @ts-expect-error EBS bandwidth demand is in bytes per request
  p.ebsBandwidth(q(1, u.op))
  // @ts-expect-error disk is a level in bytes
  p.disk(q(1, u.GB.div(u.s)))
})
