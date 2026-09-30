import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import scenario from '../examples/orders-platform.ts'
import { MONTH_SECONDS, unitCosts } from '../src/index.ts'

describe('unit cost', () => {
  const { results } = unitCosts(scenario, { rate: 1000 })
  const get = results.find((r) => r.request === 'getOrder')!

  it('evaluates each root request alone at the given rate', () => {
    expect(results.map((r) => r.request)).toEqual(['createOrder', 'getOrder', 'listOrders'])
    expect(get.requestsPerMonth).toBe(1000 * MONTH_SECONDS)
    expect(get.used + get.idle + get.fixed).toBeCloseTo(get.total, 6)
  })

  it('matches a hand-computed line item: getOrder reads 0.5 RRU per request', () => {
    const ddb = get.breakdown.find((b) => b.name === 'dynamodb:orders')!
    expect(ddb.cost).toBeCloseTo(1000 * MONTH_SECONDS * 0.5 * 0.125e-6, 6)
  })

  it('shows the minimum-size tax growing as the rate falls', () => {
    const low = unitCosts(scenario, { rate: 50, requests: ['getOrder'] }).results[0]!
    expect(low.perMillion.used).toBeCloseTo(get.perMillion.used, 6) // request-driven cost is linear
    expect(low.perMillion.allIn).toBeGreaterThan(10 * get.perMillion.allIn)
  })

  it('rejects request types with no load in the workload', () => {
    expect(() => unitCosts(scenario, { rate: 1, requests: ['nope'] })).toThrow(/no load for 'nope'/)
  })

  it('is available from the CLI as JSON', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const out = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli/main.ts',
        'unit-cost',
        'examples/orders-platform.ts',
        '--rate',
        '1000',
        '--json',
        '--no-typecheck',
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const json = JSON.parse(out)
    expect(json.rate).toBe(1000)
    expect(json.results.find((r: { request: string }) => r.request === 'getOrder').total).toBeCloseTo(get.total, 1)
  })
})
