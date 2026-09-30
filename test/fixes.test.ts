// Regressions for behavior that used to fail silently: finite last tiers, misspelt sweep params, params inside
// series and distributions, the default cost of a lone gauge meter, zero-byte requests, and unit name clashes.
import { describe, expect, it } from 'vitest'
import {
  baseUnit,
  bill,
  charge,
  defineUnit,
  dimension,
  dist,
  evaluate,
  type Expr,
  gauge,
  param,
  priceBook,
  pricing,
  q,
  request,
  scenario,
  scheduleCost,
  series,
  service,
  sweep,
  tiered,
  u,
  workload,
} from '../src/index.ts'
import { dynamoTable, s3Bucket } from '../src/catalog/aws/index.ts'

const perSecond = u.req.div(u.s)
const calls = dimension('fixes.calls', u.req, 1e-6)
const kb = dimension('fixes.kb', u.KB, 1e-6)
const stored = dimension('fixes.stored', u.GB.mul(u.month), 0.1)

const api = service('fixes-api', {
  gauges: { items: gauge(u.byte, { billAs: stored }) },
  requests: () => ({
    call: request({ bytes: u.byte }, (r) => ({ bill: [bill(calls, q(1, u.req)), bill(kb, r.bytes)] })),
  }),
})

const at = (rate: Expr<{ req: 1; s: -1 }>, params: Record<string, number> = {}) =>
  scenario({
    name: 'fixes',
    root: api,
    pricing: pricing(),
    workload: workload(api, {
      requests: { call: { rate: series.constant(rate), attrs: { bytes: q(1, u.KB) } } },
      params,
    }),
  })

describe('tiered', () => {
  it('rejects a finite last tier, unordered bounds and a null tier before the end', () => {
    expect(() => tiered([{ upTo: 100, rate: 1 }])).toThrow(/last tier must have upTo: null/)
    expect(() =>
      tiered([
        { upTo: 100, rate: 1 },
        { upTo: 50, rate: 1 },
        { upTo: null, rate: 1 },
      ]),
    ).toThrow(/must increase/)
    expect(() =>
      tiered([
        { upTo: null, rate: 1 },
        { upTo: null, rate: 1 },
      ]),
    ).toThrow(/only the last tier/)
  })
  it('prices a valid schedule as before', () => {
    const s = tiered([
      { upTo: 100, rate: 2 },
      { upTo: null, rate: 1 },
    ])
    expect(scheduleCost(s, 150)).toBe(250)
  })
})

describe('params in series and distributions', () => {
  const rate = param('fixesRate', q(10, perSecond))
  it("follow the workload's params", () => {
    const base = evaluate(at(rate)).total
    const doubled = evaluate(at(rate, { fixesRate: 20 })).total
    expect(doubled / base).toBeCloseTo(2, 6)
  })
  it('follow a sweep of the param', () => {
    const [a, b] = sweep(at(rate), { fixesRate: [10, 40] })
    expect(b!.total / a!.total).toBeCloseTo(4, 6)
  })
  it('re-resolve distributions', () => {
    const size = param('fixesSize', q(1, u.KB))
    const w = (params: Record<string, number>) =>
      workload(api, {
        requests: { call: { rate: series.constant(q(1, perSecond)), attrs: { bytes: dist.fixed(size) } } },
        params,
      })
    const s = (params: Record<string, number>) =>
      scenario({ name: 'fixes-dist', root: api, pricing: pricing(), workload: w(params) })
    const small = evaluate(s({})).dimensions.find((d) => d.id === 'fixes.kb')!.usage
    const big = evaluate(s({ fixesSize: 4000 })).dimensions.find((d) => d.id === 'fixes.kb')!.usage
    expect(big / small).toBeCloseTo(4, 6)
  })
})

describe('sweep', () => {
  it('rejects a name that is no param, request, attribute or gauge', () => {
    param('fixesRetention', q(1, u.day))
    expect(() => sweep(at(q(1, perSecond)), { fixesRetentoin: [1] })).toThrow(/unknown variable 'fixesRetentoin'/)
  })
})

describe('a price book with one gauge meter', () => {
  it('claims all gauge-driven cost without costFrom', () => {
    const book = priceBook(api, {
      meters: (m) => ({ itemMonths: m.gauge('items', u.GB.mul(u.month)) }),
      prices: [charge('itemMonths', 0.2)],
    })
    const s = scenario({
      name: 'fixes-book',
      root: api,
      pricing: pricing(),
      priceBook: book,
      workload: workload(api, {
        requests: { call: { rate: series.constant(q(0, perSecond)), attrs: { bytes: q(1, u.KB) } } },
        gauges: { items: q(100, u.GB) },
      }),
    })
    const r = evaluate(s)
    const meter = r.revenue!.meters.find((m) => m.name === 'itemMonths')!
    expect(meter.cost).toBeCloseTo(10, 6) // 100 GB-months × $0.10
  })
})

describe('zero-byte requests', () => {
  it('bill at least one request or unit', () => {
    const bucket = s3Bucket('fixes')
    const table = dynamoTable('fixes')
    const root = service('fixes-zero', {
      deps: { bucket, table },
      requests: ({ deps }) => ({
        put: request({}, () => ({
          calls: [deps.bucket.put({ bytes: q(0, u.byte) }), deps.table.write({ bytes: q(0, u.byte) })],
        })),
      }),
    })
    const r = evaluate(
      scenario({
        name: 'fixes-zero',
        root,
        pricing: pricing(),
        workload: workload(root, { requests: { put: { rate: series.constant(q(1, perSecond)), attrs: {} } } }),
      }),
    )
    const month = 730 * 3600
    expect(r.dimensions.find((d) => d.id === 'aws.s3.standard.put')!.usage).toBeCloseTo(month, 0)
    expect(r.dimensions.find((d) => d.id === 'aws.dynamodb.ondemand.wru')!.usage).toBeCloseTo(month, 0)
  })
})

describe('unit names', () => {
  it('baseUnit refuses a name defineUnit registered for another dimension', () => {
    const widget = baseUnit('fixesWidget')
    defineUnit('fixesKwidget', widget, 1000)
    expect(() => baseUnit('fixesKwidget')).toThrow(/already defined/)
    expect(() => defineUnit('fixesKwidget', u.byte, 1000)).toThrow(/already defined differently/)
  })
})
