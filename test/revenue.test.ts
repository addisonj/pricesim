// Price books (DESIGN.md §8.2): meters, charges with per-customer tiers, options, fees, discounts, minimums,
// and margin against the provider's cost. Every expected number is computed by hand.
import { describe, expect, it } from 'vitest'
import {
  baseUnit,
  bill,
  ceil,
  charge,
  dimension,
  discount,
  dist,
  evaluate,
  fee,
  fixedCharge,
  gauge,
  minimum,
  offering,
  priceBook,
  pricing,
  q,
  request,
  scenario,
  series,
  service,
  tiered,
  u,
  workload,
  type Dist,
  type PriceBook,
  type PriceElement,
  type Workload,
} from '../src/index.ts'

const MONTH = 730 * 3600
const widget = baseUnit('widget')

// provider costs: $0.01/GB written, $0.002/GB read, $0.05 per widget-month held, $10/month fixed
const writeGB = dimension('rev.write', u.GB, 0.01)
const readGB = dimension('rev.read', u.GB, 0.002)
const held = dimension('rev.held', widget.mul(u.month), 0.05)
const baseHours = dimension('rev.base', u.hour, 10 / 730)
const store = offering('store', {
  fixed: [fixedCharge(baseHours, 1)],
  gauges: { widgets: gauge(widget, { billAs: held }) },
  requests: () => ({
    write: request({ bytes: u.byte }, (r) => ({ bill: [bill(writeGB, r.bytes)] })),
    read: request({ bytes: u.byte }, (r) => ({ bill: [bill(readGB, r.bytes)] })),
  }),
})
const api = service('api', {
  deps: { store },
  gauges: { widgets: gauge(widget) },
  gaugeMap: (g, { deps }) => [deps.store.gauges.widgets(g.widgets)],
  requests: ({ deps }) => ({
    put: request({ bytes: u.byte }, (r) => ({ calls: [deps.store.write({ bytes: r.bytes })] })),
    get: request({ bytes: u.byte }, (r) => ({ calls: [deps.store.read({ bytes: r.bytes })] })),
  }),
})

/** `puts`/`gets` requests per month of `bytes` each, `widgets` held */
const load = (puts: number, gets: number, bytes: number | Dist<{ byte: 1 }>, widgets = 0, samples = 64): Workload =>
  workload(api, {
    samples,
    requests: {
      put: {
        rate: series.constant(q(puts / MONTH, u.req.div(u.s))),
        attrs: { bytes: typeof bytes === 'number' ? q(bytes, u.byte) : bytes },
      },
      get: {
        rate: series.constant(q(gets / MONTH, u.req.div(u.s))),
        attrs: { bytes: typeof bytes === 'number' ? q(bytes, u.byte) : bytes },
      },
    },
    gauges: { widgets: q(widgets, widget) },
  })

const book = (
  prices: readonly PriceElement<'writeUnits' | 'transferGB' | 'widgetMonths'>[],
  extra: { readonly allocate?: 'unallocated' | 'proportional' } = {},
) =>
  priceBook(api, {
    name: 'test book',
    meters: (m) => ({
      // write units: one per started KiB
      writeUnits: m.requests({ put: (r) => ceil(r.bytes.div(q(1, u.KiB))) }, u.one),
      transferGB: m.requests({ put: (r) => r.bytes, get: (r) => r.bytes }, u.GB),
      widgetMonths: m.gauge('widgets', widget.mul(u.month)),
    }),
    options: { network: { values: ['public', 'privatelink'], default: 'public' } },
    prices,
    ...extra,
  })

const run = (b: PriceBook, w: Workload, plan?: Record<string, string>) =>
  evaluate(
    scenario({ name: 'rev', root: api, workload: w, pricing: pricing(), priceBook: b, ...(plan ? { plan } : {}) }),
  ).revenue!

describe('price books: single customer', () => {
  // 1M puts and 3M gets of 2,000 B (2 write units each), 100 widgets
  const w = load(1e6, 3e6, 2000, 100)
  const b = book([charge('writeUnits', 1 / 1e6), charge('transferGB', 0.05), charge('widgetMonths', 0.2)])

  it('meters requests (per-request quantity from attributes) and gauges (level × time)', () => {
    const r = run(b, w)
    const qty = Object.fromEntries(r.meters.map((m) => [m.name, m.quantity]))
    expect(qty.writeUnits).toBeCloseTo(2e6, 3)
    expect(qty.transferGB).toBeCloseTo(8, 9) // 4M × 2,000 B
    expect(qty.widgetMonths).toBeCloseTo(100, 9)
    // $2 + $0.40 + $20
    expect(r.revenue).toBeCloseTo(22.4, 9)
  })

  it('margin is revenue minus the provider cost; per-meter cost follows the requests and gauges it covers', () => {
    const r = run(b, w)
    // cost: writes 2 GB × 0.01, reads 6 GB × 0.002, widgets 100 × 0.05, fixed $10
    expect(r.cost).toBeCloseTo(0.02 + 0.012 + 5 + 10, 9)
    expect(r.margin).toBeCloseTo(22.4 - 15.032, 9)
    const m = Object.fromEntries(r.meters.map((x) => [x.name, x]))
    // put's cost is claimed by writeUnits and transferGB: split by their revenue ($2 vs $0.10 of transfer on puts…)
    // transferGB revenue is $0.40 in total; the split uses meter revenues: 2 : 0.4
    expect(m.writeUnits!.cost).toBeCloseTo(0.02 * (2 / 2.4), 9)
    expect(m.transferGB!.cost).toBeCloseTo(0.02 * (0.4 / 2.4) + 0.012, 9)
    expect(m.widgetMonths!.cost).toBeCloseTo(5, 9)
    // the fixed $10 is unallocated by default
    expect(r.unallocated).toBeCloseTo(10, 9)
  })

  it("allocate: 'proportional' spreads unallocated cost over the meters", () => {
    const r = run(book(b.prices as never, { allocate: 'proportional' }), w)
    expect(r.unallocated).toBe(0)
    expect(r.meters.reduce((a, m) => a + m.cost, 0)).toBeCloseTo(r.cost, 9)
  })

  it('meters distribution-valued attributes by Monte Carlo (ceil per sample)', () => {
    const wd = load(1e6, 0, dist.uniform({ min: q(1, u.byte), max: q(3000, u.byte) }), 0, 4096)
    const units = run(b, wd).meters.find((m) => m.name === 'writeUnits')!.quantity
    // E[ceil(U(1, 3000) / 1024)] ≈ (1024·1 + 1024·2 + 952·3) / 3000 ≈ 1.976
    expect(units / 1e6).toBeCloseTo(1.976, 1)
  })
})

describe('price books: options, fees, discounts, minimums', () => {
  const w = load(1e6, 3e6, 1000)
  const b = book([
    // one meter, several prices: a base $/GB for everyone, plus a PrivateLink surcharge
    charge('transferGB', 0.05),
    charge('transferGB', 0.03, { when: { network: 'privatelink' }, name: 'privatelink transfer' }),
    fee(50, { when: { network: 'privatelink' }, name: 'privatelink attachment' }),
    minimum(100, {
      when: { network: 'privatelink' },
      name: 'privatelink minimum',
      covers: ['privatelink transfer', 'privatelink attachment'],
    }),
  ])

  it('charges apply by plan: public pays the base only', () => {
    const r = run(b, w, { network: 'public' })
    expect(r.revenue).toBeCloseTo(4 * 0.05, 9)
    expect(r.customers[0]!.plan).toEqual({ network: 'public' })
  })

  it('privatelink adds its surcharge, fee, and a minimum over just those lines', () => {
    const r = run(b, w, { network: 'privatelink' })
    const lines = Object.fromEntries(r.lines.map((l) => [l.name, l.amount]))
    expect(lines.transferGB).toBeCloseTo(0.2, 9)
    expect(lines['privatelink transfer']).toBeCloseTo(0.12, 9)
    expect(lines['privatelink attachment']).toBe(50)
    // covered: 0.12 + 50 → top-up to 100
    expect(lines['privatelink minimum']).toBeCloseTo(100 - 50.12, 9)
    expect(r.revenue).toBeCloseTo(0.2 + 100, 9)
  })

  it('the default plan is used when none is given', () => {
    expect(run(b, w).customers[0]!.plan).toEqual({ network: 'public' })
  })

  it('discounts take a fraction off the covered charges (net shows on the charge line)', () => {
    const d = book([
      charge('transferGB', 0.05),
      charge('writeUnits', 1 / 1e6),
      discount(0.2, { covers: ['transferGB'] }),
    ])
    const r = run(d, w)
    const t = r.lines.find((l) => l.name === 'transferGB')!
    expect(t.amount).toBeCloseTo(0.2, 9)
    expect(t.net).toBeCloseTo(0.16, 9)
    expect(r.lines.find((l) => l.kind === 'discount')!.amount).toBeCloseTo(-0.04, 9)
    expect(r.revenue).toBeCloseTo(0.16 + 1, 9)
  })

  it('rejects unknown meters, options, values, duplicate names and bad plans', () => {
    expect(() => book([charge('nope' as never, 1)])).toThrow(/unknown meter/)
    expect(() => book([charge('transferGB', 1, { when: { color: 'red' } })])).toThrow(/unknown option/)
    expect(() => book([charge('transferGB', 1, { when: { network: 'carrier-pigeon' } })])).toThrow(/not a value/)
    expect(() => book([charge('transferGB', 1), charge('transferGB', 2)])).toThrow(/named 'transferGB'/)
    expect(() => book([minimum(1, { covers: ['nope'] })])).toThrow(/covers unknown/)
    expect(() => run(book([charge('transferGB', 1)]), w, { network: 'x' })).toThrow(/not a value/)
    expect(() => discount(1.5)).toThrow(/fraction/)
  })
})

describe('price books: many customers', () => {
  // tiers: first 10 GB at $0.10, then $0.01
  const b = book([
    charge(
      'transferGB',
      tiered([
        { upTo: 10, rate: 0.1 },
        { upTo: null, rate: 0.01 },
      ]),
    ),
    minimum(1),
  ])
  const small = load(1e6, 0, 5000) // 5 GB
  const large = load(20e6, 0, 1000) // 20 GB

  it('applies tiers and minimums per customer, and splits cost by customer', () => {
    const r = evaluate(
      scenario({
        name: 'multi',
        root: api,
        tenants: [
          { id: 'small', workload: small },
          { id: 'large', workload: large, plan: { network: 'privatelink' } },
        ],
        pricing: pricing(),
        priceBook: b,
      }),
    ).revenue!
    const c = Object.fromEntries(r.customers.map((x) => [x.id, x]))
    // small: 5 GB × 0.10 = 0.50 → minimum tops up to 1
    expect(c.small!.revenue).toBeCloseTo(1, 9)
    // large: 10 × 0.10 + 10 × 0.01 = 1.10 (tiers are the customer's own, not pooled with small)
    expect(c.large!.revenue).toBeCloseTo(1.1, 9)
    expect(c.large!.plan).toEqual({ network: 'privatelink' })
    // cost: used 0.05 vs 0.20 (writes at $0.01/GB); the $10 fixed splits 1:4
    expect(c.small!.cost).toBeCloseTo(0.05 + 10 * 0.2, 9)
    expect(c.large!.cost).toBeCloseTo(0.2 + 10 * 0.8, 9)
    expect(r.revenue).toBeCloseTo(2.1, 9)
    expect(r.cost).toBeCloseTo(10.25, 9)
    expect(r.marginRate).toBeCloseTo((2.1 - 10.25) / 2.1, 9)
  })

  it('excludes costs billed to other accounts from the provider cost', () => {
    const customerSide = service('customer-side', {
      account: 'customer',
      deps: {
        store: offering('their-store', {
          requests: () => ({ w: request({ bytes: u.byte }, (r) => ({ bill: [bill(writeGB, r.bytes)] })) }),
        }),
      },
      requests: ({ deps }) => ({
        put: request({ bytes: u.byte }, (r) => ({ calls: [deps.store.w({ bytes: r.bytes })] })),
      }),
    })
    const root = service('root', {
      deps: { api, customerSide },
      requests: ({ deps }) => ({
        put: request({ bytes: u.byte }, (r) => ({
          calls: [deps.api.put({ bytes: r.bytes }), deps.customerSide.put({ bytes: r.bytes })],
        })),
      }),
    })
    const b2 = priceBook(root, {
      meters: (m) => ({ gb: m.requests({ put: (r) => r.bytes }, u.GB) }),
      prices: [charge('gb', 1)],
    })
    const res = evaluate(
      scenario({
        name: 'acct',
        root,
        workload: workload(root, {
          requests: {
            put: { rate: series.constant(q(1e6 / MONTH, u.req.div(u.s))), attrs: { bytes: q(1000, u.byte) } },
          },
        }),
        pricing: pricing(),
        priceBook: b2,
      }),
    )
    // provider: 1 GB × 0.01 + $10 fixed; the customer's own 1 GB × 0.01 is not the provider's cost
    expect(res.revenue!.cost).toBeCloseTo(10.01, 9)
    expect(res.total).toBeCloseTo(10.02, 9)
  })
})
