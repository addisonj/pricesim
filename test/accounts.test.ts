// Payer accounts: charges can land on different AWS bills (provider vs customer); tiers pool per account.
import { describe, expect, it } from 'vitest'
import {
  bill,
  closedForm,
  dimension,
  evaluate,
  fixedCharge,
  offering,
  pricing,
  q,
  request,
  scenario,
  series,
  service,
  tiered,
  u,
  unitCosts,
  workload,
} from '../src/index.ts'

const H = 730
const lbHours = dimension('acct.lb.hours', u.hour, 0.02)
const processed = dimension(
  'acct.processed',
  u.GB,
  tiered([
    { upTo: 1000, rate: 0.01 },
    { upTo: null, rate: 0.005 },
  ]),
)
const endpoint = offering('endpoint', {
  fixed: [fixedCharge(lbHours, 1)],
  requests: () => ({ process: request({ bytes: u.byte }, (r) => ({ bill: [bill(processed, r.bytes)] })) }),
})
const nlb = offering('nlb', {
  fixed: [fixedCharge(lbHours, 1)],
  requests: () => ({ forward: request({ bytes: u.byte }, (r) => ({ bill: [bill(processed, r.bytes)] })) }),
})
// the customer's side: their endpoint bills to them; the provider's NLB bills to the provider
const customerSide = service('customer-side', {
  account: 'customer',
  deps: { endpoint },
  requests: ({ deps }) => ({
    send: request({ bytes: u.byte }, (r) => ({ calls: [deps.endpoint.process({ bytes: r.bytes })] })),
  }),
})
const api = service('api', {
  deps: { customerSide, nlb },
  requests: ({ deps }) => ({
    put: request({ bytes: u.byte }, (r) => ({
      calls: [deps.customerSide.send({ bytes: r.bytes }), deps.nlb.forward({ bytes: r.bytes })],
    })),
  }),
})
// 1 MB/s for a month = 2,628 GB through each side
const s = scenario({
  name: 'accounts',
  root: api,
  pricing: pricing(),
  workload: workload(api, {
    requests: { put: { rate: series.constant(q(1, u.req.div(u.s))), attrs: { bytes: q(1, u.MB) } } },
  }),
})
const r = evaluate(s)
const GB = 2628
const tierCost = 1000 * 0.01 + (GB - 1000) * 0.005

describe('payer accounts', () => {
  it('splits cost by account, with fixed charges on the owning account', () => {
    const acct = Object.fromEntries(r.accounts!.map((a) => [a.name, a]))
    expect(acct.customer!.total).toBeCloseTo(H * 0.02 + tierCost, 6)
    expect(acct.provider!.total).toBeCloseTo(H * 0.02 + tierCost, 6)
    expect(acct.customer!.fixed).toBeCloseTo(H * 0.02, 6)
    expect(r.accounts!.reduce((a, x) => a + x.total, 0)).toBeCloseTo(r.total, 6)
  })

  it('pools tiers per account, not across accounts', () => {
    // pooled across both accounts, 5,256 GB would put more usage in the cheaper tier
    const pooled = 1000 * 0.01 + (2 * GB - 1000) * 0.005
    expect(r.total - 2 * H * 0.02).toBeCloseTo(2 * tierCost, 6)
    expect(2 * tierCost).toBeGreaterThan(pooled)
    expect(
      r.dimensions
        .filter((d) => d.id === 'acct.processed')
        .map((d) => d.account)
        .sort(),
    ).toEqual(['customer', 'provider'])
  })

  it('puts the account at the top of the tree when there are several', () => {
    expect(r.tree.children!.map((c) => [c.kind, c.name]).sort()).toEqual([
      ['account', 'customer'],
      ['account', 'provider'],
    ])
  })

  it('keeps single-account results unchanged (no accounts section)', () => {
    const noCustomer = service('plain', {
      deps: { nlb },
      requests: ({ deps }) => ({
        put: request({ bytes: u.byte }, (r) => ({ calls: [deps.nlb.forward({ bytes: r.bytes })] })),
      }),
    })
    const plain = evaluate(
      scenario({
        name: 'plain',
        root: noCustomer,
        pricing: pricing(),
        workload: workload(noCustomer, {
          requests: { put: { rate: series.constant(q(1, u.req.div(u.s))), attrs: { bytes: q(1, u.MB) } } },
        }),
      }),
    )
    expect(plain.accounts).toBeUndefined()
    expect(plain.dimensions.every((d) => d.account === undefined)).toBe(true)
  })

  it('closed forms price each account at its own effective rate', () => {
    expect(closedForm(s).value).toBeCloseTo(r.total, 6)
  })
})

describe('several accounts with tenants or unit costs', () => {
  const at = (mbps: number) =>
    workload(api, {
      requests: { put: { rate: series.constant(q(mbps, u.req.div(u.s))), attrs: { bytes: q(1, u.MB) } } },
    })

  it('attributes every tenant its used cost across accounts', () => {
    const r = evaluate(
      scenario({
        name: 'accounts-tenants',
        root: api,
        pricing: pricing(),
        tenants: [
          { id: 'a', workload: at(1) },
          { id: 'b', workload: at(3) },
        ],
      }),
    )
    const [a, b] = r.tenants!
    expect(a!.used).toBeGreaterThan(0)
    expect(b!.used / a!.used).toBeCloseTo(3, 6)
    expect(a!.total + b!.total).toBeCloseTo(r.total, 6)
  })

  it('breaks a request down across accounts in unitCosts', () => {
    const { results } = unitCosts(s, { rate: 1 })
    const names = results[0]!.breakdown.map((x) => x.name)
    expect(names).toEqual(expect.arrayContaining(['customer-side', 'nlb']))
    expect(results[0]!.breakdown.reduce((t, x) => t + x.cost, 0)).toBeCloseTo(results[0]!.used, 6)
  })
})
