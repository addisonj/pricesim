import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import scenario from '../examples/orders-platform.ts'
import { evaluate, parseRangeSpec, range, sweep, sweepCsv, withOverrides } from '../src/index.ts'

describe('sweep', () => {
  it('builds linear and log ranges', () => {
    expect(range(0, 10, 3)).toEqual([0, 5, 10])
    const log = range(10, 1000, 3, { log: true })
    expect(log[1]).toBeCloseTo(100, 9)
    expect(parseRangeSpec('1..100:log:3').map((v) => Math.round(v))).toEqual([1, 10, 100])
    expect(parseRangeSpec('1,2,5')).toEqual([1, 2, 5])
    expect(() => parseRangeSpec('a..b')).toThrow()
  })

  it('evaluates the cartesian product, one row per point', () => {
    const rows = sweep(scenario, { 'rate.getOrder': [100, 1000], 'gauge.orders': [0, 1e6] })
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.inputs)).toEqual([
      { 'rate.getOrder': 100, 'gauge.orders': 0 },
      { 'rate.getOrder': 100, 'gauge.orders': 1e6 },
      { 'rate.getOrder': 1000, 'gauge.orders': 0 },
      { 'rate.getOrder': 1000, 'gauge.orders': 1e6 },
    ])
    for (const r of rows) expect(r.used + r.idle + r.fixed).toBeCloseTo(r.total, 6)
  })

  it('scales a request series to the requested mean', () => {
    const base = evaluate(scenario)
    const same = sweep(scenario, { 'rate.createOrder': [meanCreate()] })[0]!
    expect(same.total).toBeCloseTo(base.total, 6)
  })

  it('overrides attributes and params', () => {
    const small = evaluate(withOverrides(scenario, { 'listOrders.pageSize': 1 }))
    const big = evaluate(withOverrides(scenario, { 'listOrders.pageSize': 100 }))
    expect(big.total).toBeGreaterThan(small.total)
    expect(() => withOverrides(scenario, { 'nope.bytes': 1 })).toThrow(/no request 'nope'/)
    expect(() => withOverrides(scenario, { 'gauge.nope': 1 })).toThrow(/unknown variable/)
  })

  it('exports CSV with inputs, totals, dimensions and pools', () => {
    const csv = sweepCsv(sweep(scenario, { 'rate.getOrder': [100] }))
    const [header, row] = csv.trim().split('\n')
    expect(header).toMatch(/^rate\.getOrder,total,used,idle,fixed,dim:/)
    expect(header).toContain('pool:orders-api')
    expect(row!.split(',')).toHaveLength(header!.split(',').length)
  })

  it('is available from the CLI', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const out = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli/main.ts',
        'sweep',
        'examples/orders-platform.ts',
        '--var',
        'rate.getOrder=10..1000:log:3',
        '--csv',
        '--no-typecheck',
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    expect(out.trim().split('\n')).toHaveLength(4)
  })
})

/** mean createOrder rate of the example's diurnal series (hourly midpoints over 730 h) */
function meanCreate() {
  let sum = 0
  for (let i = 0; i < 730; i++) sum += 150 * (1 + Math.cos((2 * Math.PI * (i + 0.5 - 18)) / 24))
  return sum / 730
}

describe('derived gauges', () => {
  it('follow rate overrides: doubling createOrder doubles retained-order storage', () => {
    const [a, b] = sweep(scenario, { 'rate.createOrder': [100, 200] })
    const s3 = (r: typeof a) => r!.dimensions['aws.s3.standard.storage']!
    expect(s3(b) / s3(a)).toBeCloseTo(2, 6)
  })
})
