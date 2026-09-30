// End-to-end checks on examples/orders-platform.ts: hand-computed bills, capacity sizing, invariants,
// and the CLI's JSON output against the checked-in golden file.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import scenario from '../examples/orders-platform.ts'
import { evaluate, roundResult, type CostNode } from '../src/index.ts'

const r = evaluate(scenario)
const HOURS = 730
const T = HOURS * 3600

/** ∫ rate dt for the example's diurnal series, integrated the way the engine does (hourly midpoints) */
const integrate = (mean: number, peakToMean: number) => {
  let sum = 0
  for (let i = 0; i < HOURS; i++)
    sum += mean * (1 + (peakToMean - 1) * Math.cos((2 * Math.PI * (i + 0.5 - 18)) / 24)) * 3600
  return sum
}
const creates = integrate(150, 2)
/** retained orders: mean createOrder rate × 30 days (derived gauge in the example) */
const ORDERS = (creates / T) * 30 * 86400
const gets = integrate(1200, 1.8)
const lists = integrate(80, 2)

const dim = (id: string) => {
  const d = r.dimensions.find((x) => x.id === id)
  if (!d) throw new Error(`no dimension ${id}`)
  return d
}
const find = (n: CostNode, path: string[]): CostNode => {
  let cur = n
  for (const name of path) {
    const next = cur.children?.find((c) => c.name === name)
    if (!next) throw new Error(`no node '${name}' under '${cur.name}'`)
    cur = next
  }
  return cur
}

describe('orders-platform: hand-computed bills', () => {
  it('DynamoDB write units: 2 KB items → 2 WRU, ×2 for the GSI, per createOrder', () => {
    expect(dim('aws.dynamodb.ondemand.wru').usage).toBeCloseTo(creates * 4, -3)
    expect(dim('aws.dynamodb.ondemand.wru').cost).toBeCloseTo(creates * 4 * 0.625e-6, 6)
  })

  it('DynamoDB read units: getOrder 0.5 RRU; listOrders 25 KB → 7 × 0.5 RRU', () => {
    expect(dim('aws.dynamodb.ondemand.rru').usage).toBeCloseTo(gets * 0.5 + lists * 3.5, -3)
  })

  it('DynamoDB storage: retained orders × 4 KB, first 25 GB free', () => {
    const gb = (ORDERS * 4e3) / 1e9
    expect(dim('aws.dynamodb.storage').usage).toBeCloseTo(gb, 6)
    expect(dim('aws.dynamodb.storage').cost).toBeCloseTo((gb - 25) * 0.25, 6)
  })

  it('S3: 30% of creates PUT a receipt, 5% of gets GET it, 30% of orders store 20 KB', () => {
    expect(dim('aws.s3.standard.put').cost).toBeCloseTo(creates * 0.3 * 0.005e-3, 6)
    expect(dim('aws.s3.standard.get').cost).toBeCloseTo(gets * 0.05 * 0.0004e-3, 6)
    expect(dim('aws.s3.standard.storage').cost).toBeCloseTo(ORDERS * 6e3 * 1e-9 * 0.023, 6)
  })

  it('Aurora I/O: record(2 entries) = 2 reads + 6 writes; balance = 4 reads', () => {
    expect(dim('aws.aurora.io').usage).toBeCloseTo(creates * 8 + lists * 4, -3)
    expect(dim('aws.aurora.storage').usage).toBeCloseTo(ORDERS * 2 * 300 * 1e-9, 6)
  })

  it('cross-AZ transfer: 2/3 of bytes cross, charged both ways', () => {
    const bytes = creates * (2e3 + 4e3) + gets * 2e3 + lists * 25e3
    expect(dim('aws.transfer.inter-az').usage).toBeCloseTo(((bytes * 2) / 3) * 2 * 1e-9, 3)
  })
})

describe('orders-platform: capacity', () => {
  const pool = (name: string) => r.pools.find((p) => p.name === name)!

  it('sizes orders-api pods on peak CPU', () => {
    // peak at the hour-17.5 midpoint: cos(π/24); per-request core·ms: create 5.5, get 1.5, list 5.5
    const c = Math.cos(Math.PI / 24)
    const peakCores = (150 * (1 + c) * 5.5 + 1200 * (1 + 0.8 * c) * 1.5 + 80 * (1 + c) * 5.5) / 1000
    expect(pool('orders-api').resources.cpu!.peak).toBeCloseTo(peakCores * 1000, 6)
    expect(pool('orders-api').count).toBe(Math.ceil(peakCores / 0.6))
    expect(pool('orders-api').binding).toBe('cpu')
  })

  it('sizes inventory pods on memory held by the SKU cache (2M × 2 KB)', () => {
    expect(pool('inventory').count).toBe(Math.ceil((2e6 * 2e3) / (1024 ** 3 * 0.6)))
    expect(pool('inventory').binding).toBe('memory')
  })

  it('keeps both node pools and the Aurora cluster at their minimums', () => {
    expect(pool('orders-nodes')).toMatchObject({ count: 3, binding: 'min' })
    expect(pool('shared-nodes')).toMatchObject({ count: 3, binding: 'min' })
    expect(pool('aurora:ledger')).toMatchObject({ count: 2, instance: 'db.r7g.large' })
  })
})

describe('orders-platform: invariants', () => {
  it('node pool and instance costs are fully allocated (used + idle = provisioned)', () => {
    expect(dim('aws.ec2.m7g.2xlarge.hours')).toMatchObject({ usage: expect.closeTo(3 * HOURS, 6) })
    expect(dim('aws.ec2.m7g.2xlarge.hours').cost).toBeCloseTo(3 * HOURS * 0.3264, 6)
    expect(dim('aws.ec2.m7g.xlarge.hours').cost).toBeCloseTo(3 * HOURS * 0.1632, 6)
    expect(dim('aws.aurora-postgresql.db.r7g.large.hours').cost).toBeCloseTo(2 * HOURS * 0.276, 6)
  })

  it('tree total = sum of dimensions = used + idle + fixed', () => {
    const sum = r.dimensions.reduce((a, d) => a + d.cost, 0)
    expect(r.total).toBeCloseTo(sum, 6)
    expect(r.used + r.idle + r.fixed).toBeCloseTo(r.total, 6)
    const children = r.tree.children!.reduce((a, c) => a + c.cost, 0)
    expect(children).toBeCloseTo(r.total, 6)
  })

  it('attributes shared-pool cost to the calling request path', () => {
    const inv = find(r.tree, ['orders', 'createOrder', 'inventory', 'reserve', 'inventory'])
    expect(inv.kind).toBe('pool')
    expect(inv.cost).toBeGreaterThan(0)
    const idle = find(r.tree, ['idle', 'shared-nodes'])
    expect(idle.children!.map((c) => c.name).sort()).toEqual(
      ['node slack', 'pod headroom: inventory', 'pod headroom: ledger', 'system overhead'].sort(),
    )
  })

  it('charges the inventory SKU cache for its memory share of the shared node pool (dominant share)', () => {
    // shared-nodes is at its minimum, so no dimension binds; the SKU cache holds 2M × 2 KB = 4e9 bytes all
    // month on m7g.xlarge nodes (16 GiB, $0.1632/h): 4e9 / 16 GiB = 0.2328 node → × 730 h × $0.1632 = $27.74.
    // With binding-only attribution this path was not charged; the same amount moved out of the inventory pod
    // headroom (inventory requests 7 pods × max(500/4000 cpu, 1/16 memory) = 0.875 node, unchanged), so the
    // node pool's total, 3 × 730 h × $0.1632, is the same.
    const node = 4e9 / (16 * 1024 ** 3)
    expect(find(r.tree, ['orders', 'gauges', 'inventory', 'gauges', 'memory', 'inventory']).cost).toBeCloseTo(
      node * HOURS * 0.1632,
      6,
    )
    // inventory's used lines plus its pod headroom add up to its requests
    const poolLines = (n: CostNode): number =>
      n.kind === 'pool' && n.name === 'inventory' ? n.cost : (n.children ?? []).reduce((a, c) => a + poolLines(c), 0)
    const headroom = find(r.tree, ['idle', 'shared-nodes', 'pod headroom: inventory']).cost
    expect(poolLines(find(r.tree, ['orders'])) + headroom).toBeCloseTo(0.875 * HOURS * 0.1632, 6)
    expect(dim('aws.ec2.m7g.xlarge.hours').cost).toBeCloseTo(3 * HOURS * 0.1632, 6)
  })

  it('reports period and totals', () => {
    expect(r.period).toEqual({ hours: HOURS, steps: HOURS })
    expect(T).toBe(2_628_000)
  })
})

describe('pricesim eval --json', () => {
  it('produces the expected JSON for the example (golden file)', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const out = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/main.ts', 'eval', 'examples/orders-platform.ts', '--json', '--no-typecheck'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const actual = JSON.parse(out)
    const expected = JSON.parse(
      readFileSync(new URL('../examples/orders-platform.expected.json', import.meta.url), 'utf8'),
    )
    expect(actual).toEqual(expected)
    // and the CLI output is exactly the rounded in-process result
    expect(actual).toEqual(JSON.parse(JSON.stringify(roundResult(r))))
  })
})
