import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import scenario from '../examples/orders-platform.ts'
import {
  bill,
  closedForm,
  dimension,
  evaluate,
  MONTH_SECONDS,
  opaque,
  pricing,
  q,
  request,
  scenario as scenario2,
  series,
  service,
  u,
  withWorkload,
  workload,
  type Scenario,
} from '../src/index.ts'

/** the example with every request rate scaled by k */
const scaled = (s: Scenario, k: number): Scenario =>
  withWorkload(s, {
    ...s.workload!,
    requests: Object.fromEntries(
      Object.entries(s.workload!.requests).map(([n, l]) => [
        n,
        { ...l!, rate: { describe: `${k}×`, at: (t: number) => k * l!.rate.at(t) } },
      ]),
    ),
  })

describe('closed form', () => {
  const exact = closedForm(scenario)
  const relaxed = closedForm(scenario, { mode: 'relaxed' })

  it('exact mode reproduces the numeric evaluation at the operating point', () => {
    expect(exact.value).toBeCloseTo(evaluate(scenario).total, 6)
    expect(exact.expression).toMatch(/ceil/)
    expect(exact.linear).toBeUndefined()
  })

  it('relaxed mode is linear in the request rates and below exact (no min sizes, no rounding up)', () => {
    expect(relaxed.linear).toBeDefined()
    expect(relaxed.value).toBeLessThan(exact.value)
    const { constant, perUnit } = relaxed.linear!
    const rebuilt = constant + relaxed.symbols.filter((s) => s.kept).reduce((a, s) => a + perUnit[s.id]! * s.value, 0)
    expect(rebuilt).toBeCloseTo(relaxed.value, 6)
  })

  it('relaxed converges to exact at scale, where ceil and minimums stop mattering', () => {
    const big = scaled(scenario, 200)
    const e = closedForm(big).value
    const r = closedForm(big, { mode: 'relaxed' }).value
    expect(Math.abs(e - r) / e).toBeLessThan(0.02)
  })

  it('hand-checks the per-request getOrder usage coefficient (DynamoDB + S3 GET)', () => {
    // 0.5 RRU × $0.125/M + 5% × $0.4/M S3 GET, per request, × seconds per month → USD/month per req/s
    expect(relaxed.expression).toContain(
      `${Number(((0.5 * 0.125e-6 + 0.05 * 0.4e-6) * MONTH_SECONDS).toPrecision(6))} * rate_getOrder`,
    )
  })

  it('keeps attributes symbolic on request, and binds everything else', () => {
    const cf = closedForm(scenario, { mode: 'relaxed', keep: ['rate.createOrder', 'createOrder.bytes'] })
    expect(cf.expression).toMatch(/createOrder_bytes/)
    expect(cf.expression).not.toMatch(/rate_getOrder/)
    // ceil(bytes / 1 KB) for DynamoDB write units keeps it non-linear in the attribute
    expect(cf.linear).toBeUndefined()
    expect(cf.value).toBeCloseTo(relaxed.value, 6)
  })

  it('rejects unknown symbols', () => {
    expect(() => closedForm(scenario, { keep: ['rate.nope'] })).toThrow(/unknown symbol 'rate.nope'/)
  })

  it('rejects opaque functions in model logic (they have no closed form)', () => {
    const dim = dimension('test.ops', u.op, 1e-6)
    const svc = service('svc', {
      requests: () => ({
        call: request({ n: u.count }, (r) => ({
          bill: [
            bill(
              dim,
              opaque('lookup', { inputs: { n: r.n }, unit: u.op }, ({ n }) => n * 2),
            ),
          ],
        })),
      }),
    })
    const w = workload(svc, {
      requests: { call: { rate: series.constant(q(10, u.req.div(u.s))), attrs: { n: q(3, u.count) } } },
    })
    const s = scenario2({ name: 'opaque', root: svc, workload: w, pricing: pricing() })
    expect(evaluate(s).total).toBeGreaterThan(0)
    expect(() => closedForm(s)).toThrow(/opaque function 'lookup'/)
  })

  it('is available from the CLI as JSON', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const out = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli/main.ts',
        'closed',
        'examples/orders-platform.ts',
        '--mode',
        'relaxed',
        '--json',
        '--no-typecheck',
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const json = JSON.parse(out)
    expect(json.mode).toBe('relaxed')
    expect(Object.keys(json.linear.perUnit).sort()).toEqual(['rate_createOrder', 'rate_getOrder', 'rate_listOrders'])
  })
})

describe('closed form with derived gauges', () => {
  it('folds rate-derived storage into the rate coefficient', () => {
    const r = closedForm(scenario, { mode: 'relaxed' })
    expect(r.symbols.some((s) => s.name === 'gauge.orders')).toBe(false)
    // S3 storage for 30 days of orders: 6 KB/order × 30 d × $0.023/GB-month, per req/s of createOrder
    const s3PerRate = 6e3 * 30 * 86400 * 1e-9 * 0.023
    const without = closedForm(scenario, { mode: 'relaxed' }).linear!.perUnit.rate_createOrder!
    expect(without).toBeGreaterThan(s3PerRate)
    expect(r.value).toBeCloseTo(
      r.linear!.constant + r.symbols.filter((s) => s.kept).reduce((a, s) => a + r.linear!.perUnit[s.id]! * s.value, 0),
      6,
    )
  })
})
