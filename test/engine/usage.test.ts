// Usage phase through the public API: call multiplicity, attribute propagation, gauges, params and
// cross-AZ edges. Hand computations use M = 2,628,000 s (one 730-hour month, the default period).
import { describe, expect, it } from 'vitest'
import {
  bill,
  ceil,
  dimension,
  edge,
  evaluate,
  gauge,
  instancePool,
  offering,
  param,
  q,
  request,
  scenario,
  service,
  u,
  workload,
  type EdgePattern,
} from '../../src/index.ts'
import {
  H,
  instanceType,
  list,
  leafPaths,
  M,
  dimOf,
  nodeAt,
  poolOf,
  requestDim,
  rps,
  storageDim,
  transferDim,
} from './fixtures.ts'

describe('call multiplicity', () => {
  const ops = requestDim('t.mult.ops') // $1 per million
  const leaf = offering('leaf', {
    requests: () => ({ op: request({}, () => ({ bill: [bill(ops, q(1, u.req))] })) }),
  })
  const mid = service('mid', {
    deps: { leaf },
    // chained times multiply on the call: 2 × 5 = 10 leaf ops per mid.hit
    requests: ({ deps }) => ({ hit: request({}, () => ({ calls: [deps.leaf.op({}).times(2).times(5)] })) }),
  })
  const top = service('top', {
    deps: { mid, leaf },
    requests: ({ deps }) => ({
      // 30% of requests call mid.hit: 0.3 × 10 = 3 leaf ops per top.go
      go: request({}, () => ({ calls: [deps.mid.hit({}).times(0.3)] })),
      // number × Expr multiplicity: 0.5 × 4 = 2 ops
      mixed: request({}, () => ({ calls: [deps.leaf.op({}).times(0.5).times(q(4, u.one))] })),
      // multiplicity 0 is pruned
      never: request({}, () => ({ calls: [deps.leaf.op({}).times(0)] })),
      // a param multiplicity that the workload sets to 0 is pruned as well
      off: request({}, () => ({ calls: [deps.leaf.op({}).times(param('offFanout', q(1, u.one)))] })),
    }),
  })
  const run = (req: 'go' | 'mixed' | 'never' | 'off', rate: number, params = {}) =>
    evaluate(
      scenario({
        name: req,
        root: top,
        workload: workload(top, { requests: { [req]: { rate: rps(rate), attrs: {} } }, params }),
        pricing: list,
      }),
    )

  it('multiplies nested multiplicities down the call chain', () => {
    // 1 req/s × M s × 3 ops = 7,884,000 ops → $7.884
    const r = run('go', 1)
    expect(dimOf(r, 't.mult.ops').usage).toBeCloseTo(3 * M, 3)
    expect(dimOf(r, 't.mult.ops').cost).toBeCloseTo(7.884, 9)
    const leafNode = nodeAt(r.tree, ['top', 'go', 'mid', 'hit', 'leaf', 'op', 't.mult.ops'])
    expect(leafNode).toMatchObject({ kind: 'dimension', usage: expect.closeTo(3 * M, 3), unit: 'req' })
    expect(nodeAt(r.tree, ['top', 'go', 'mid']).kind).toBe('service')
    expect(nodeAt(r.tree, ['top', 'go', 'mid', 'hit', 'leaf']).kind).toBe('offering')
  })

  it('combines number and Expr multiplicities', () => {
    // 3 req/s × 2 ops = 6 ops/s → 6M ops
    expect(dimOf(run('mixed', 3), 't.mult.ops').usage).toBeCloseTo(6 * M, 3)
  })

  it('prunes zero-multiplicity calls (no ledger line at all)', () => {
    const r = run('never', 1)
    expect(r.dimensions).toEqual([])
    expect(r.total).toBe(0)
    expect(r.tree.children ?? []).toEqual([])
  })

  // Note: the symbolic-usage refactor on main (78a480c) only prunes multiplicities that are a literal 0,
  // so a param set to 0 leaves zero-usage ledger lines (and needs interAz for edges below it). This test
  // and 'needs no interAz dimension for an edge behind a call whose multiplicity is 0' pin the old behavior.
  it('prunes calls whose param multiplicity is overridden to 0', () => {
    expect(dimOf(run('off', 1), 't.mult.ops').usage).toBeCloseTo(M, 3)
    // with the multiplicity at 0 the leaf is never reached: no dimension line, no tree node
    const r = run('off', 1, { offFanout: 0 })
    expect(r.dimensions.map((d) => d.id)).toEqual([])
    expect(r.tree.children ?? []).toEqual([])
  })
})

describe('attribute propagation through three levels of services', () => {
  const written = dimension('t.attr.bytes', u.GB, 1) // $1 per GB written
  const disk = offering('disk', {
    requests: () => ({ put: request({ bytes: u.byte }, (r) => ({ bill: [bill(written, r.bytes)] })) }),
  })
  // level 3: adds a 100-byte header
  const inner = service('inner', {
    deps: { disk },
    requests: ({ deps }) => ({
      put: request({ bytes: u.byte }, (r) => ({ calls: [deps.disk.put({ bytes: r.bytes.add(q(100, u.byte)) })] })),
    }),
  })
  // level 2: writes `copies` copies (a count attribute turned into a multiplicity)
  const middle = service('middle', {
    deps: { inner },
    requests: ({ deps }) => ({
      fwd: request({ bytes: u.byte, copies: u.count }, (r) => ({
        calls: [deps.inner.put({ bytes: r.bytes }).times(r.copies.div(q(1, u.count)))],
      })),
    }),
  })
  // level 1: doubles the payload
  const outer = service('outer', {
    deps: { middle },
    requests: ({ deps }) => ({
      go: request({ bytes: u.byte }, (r) => ({
        calls: [deps.middle.fwd({ bytes: r.bytes.mul(2), copies: q(3, u.count) })],
      })),
    }),
  })

  it('evaluates each level with the attributes its caller passed', () => {
    // 1 KB → 2000 B → ×3 copies of (2000 + 100) B = 6300 B per root request
    // 1 req/s × M × 6300 B = 16,556,400,000 B = 16.5564 GB → $16.5564
    const w = workload(outer, { requests: { go: { rate: rps(1), attrs: { bytes: q(1, u.KB) } } } })
    const r = evaluate(scenario({ name: 'attrs', root: outer, workload: w, pricing: list }))
    expect(dimOf(r, 't.attr.bytes')).toMatchObject({ usage: expect.closeTo(16.5564, 9), unit: 'GB' })
    expect(r.total).toBeCloseTo(16.5564, 9)
    expect(leafPaths(r.tree)).toEqual(['outer/go/middle/fwd/inner/put/disk/put/t.attr.bytes'])
  })

  it('rejects a workload that omits a declared attribute', () => {
    const w = workload(outer, { requests: { go: { rate: rps(1), attrs: {} as never } } })
    expect(() => evaluate(scenario({ name: 'missing', root: outer, workload: w, pricing: list }))).toThrow(/bytes/)
  })
})

describe('gauges', () => {
  const stored = storageDim('t.gauge.stored') // $0.10 per GB-month
  const disk = offering('disk', { gauges: { bytes: gauge(u.byte, { billAs: stored }) }, requests: () => ({}) })
  // two parents map onto the same child gauge
  const left = service('left', {
    deps: { disk },
    gauges: { files: gauge(u.count) },
    requests: () => ({}),
    gaugeMap: (g, { deps }) => [deps.disk.gauges.bytes(g.files.mul(q(1, u.GB.div(u.count))))],
  })
  const right = service('right', {
    deps: { disk },
    gauges: { blobs: gauge(u.count) },
    requests: () => ({}),
    // one parent mapping twice onto the same child gauge: the mappings add up
    gaugeMap: (g, { deps }) => [
      deps.disk.gauges.bytes(g.blobs.mul(q(2, u.GB.div(u.count)))),
      deps.disk.gauges.bytes(q(5, u.GB)),
    ],
  })
  const app = service('app', {
    deps: { left, right },
    gauges: { items: gauge(u.count) },
    requests: () => ({}),
    gaugeMap: (g, { deps }) => [deps.left.gauges.files(g.items.mul(10)), deps.right.gauges.blobs(g.items)],
  })
  const w = workload(app, { requests: {}, gauges: { items: q(100, u.count) } })
  const r = evaluate(scenario({ name: 'gauges', root: app, workload: w, pricing: list }))

  it('propagates levels through gaugeMap and bills them as level × time (GB-month)', () => {
    // left: 100 items × 10 files × 1 GB = 1000 GB; right: 100 blobs × 2 GB + 5 GB = 205 GB
    // held for the whole month: 1205 GB-month × $0.10 = $120.50
    expect(dimOf(r, 't.gauge.stored')).toMatchObject({ usage: expect.closeTo(1205, 9), unit: 'GB*month' })
    expect(r.total).toBeCloseTo(120.5, 9)
    expect(r.used).toBeCloseTo(120.5, 9)
  })

  it('keeps each parent on its own path in the tree', () => {
    const viaLeft = nodeAt(r.tree, ['app', 'gauges', 'left', 'gauges', 'disk', 'gauges', 'bytes', 't.gauge.stored'])
    const viaRight = nodeAt(r.tree, ['app', 'gauges', 'right', 'gauges', 'disk', 'gauges', 'bytes', 't.gauge.stored'])
    expect(viaLeft).toMatchObject({ cost: expect.closeTo(100, 9), usage: expect.closeTo(1000, 9) })
    expect(viaRight).toMatchObject({ cost: expect.closeTo(20.5, 9), usage: expect.closeTo(205, 9) })
    expect(nodeAt(r.tree, ['app', 'gauges']).kind).toBe('gauges')
    expect(nodeAt(r.tree, ['app', 'gauges', 'left', 'gauges', 'disk', 'gauges', 'bytes']).kind).toBe('gauge')
  })

  it('does not bill gauges whose level is zero or unset', () => {
    const empty = workload(app, { requests: {} })
    const r0 = evaluate(scenario({ name: 'empty', root: app, workload: empty, pricing: list }))
    // the constant 5 GB mapping from `right` is still billed: 5 GB-month × $0.10
    expect(dimOf(r0, 't.gauge.stored').usage).toBeCloseTo(5, 9)
    expect(r0.total).toBeCloseTo(0.5, 9)
    expect(leafPaths(r0.tree)).toEqual(['app/gauges/right/gauges/disk/gauges/bytes/t.gauge.stored'])
  })

  // BUG (src/eval/usage.ts, expandGauges): a shared child reached from two parents is expanded once per
  // parent, so its gaugeUse/gaugeMap see each parent's level separately instead of the total. Mappings from
  // one parent are summed first (see `right` above), so the result depends on how the graph is drawn.
  // Linear gauge functions are unaffected; non-linear ones (ceil, max, min) are not.
  // Here: segments = ceil(bytes / 1 GB), 1 GB of memory each, on a 1 GB instance with loadFactor 1.
  //   expected: ceil((1.5 + 1.5) GB / 1 GB) = 3 segments → 3 GB → 3 instances
  //   actual:   ceil(1.5) + ceil(1.5)       = 4 segments → 4 GB → 4 instances
  it('sizes a shared child from the total of its parents’ levels (non-linear gaugeUse)', () => {
    const vm = instanceType('shared-gauge-vm')
    const log = service('log', {
      pools: { vms: instancePool('log-vms', { instance: vm, min: 1, loadFactor: 1, azs: 1 }) },
      gauges: { bytes: gauge(u.byte) },
      requests: () => ({}),
      gaugeUse: (g, { pools }) => [pools.vms.memory(ceil(g.bytes.div(q(1, u.GB))).mul(q(1, u.GB)))],
    })
    const a = service('a', {
      deps: { log },
      gauges: { held: gauge(u.byte) },
      requests: () => ({}),
      gaugeMap: (g, { deps }) => [deps.log.gauges.bytes(g.held)],
    })
    const b = service('b', {
      deps: { log },
      gauges: { held: gauge(u.byte) },
      requests: () => ({}),
      gaugeMap: (g, { deps }) => [deps.log.gauges.bytes(g.held)],
    })
    const root = service('root', {
      deps: { a, b },
      gauges: { held: gauge(u.byte) },
      requests: () => ({}),
      gaugeMap: (g, { deps }) => [deps.a.gauges.held(g.held), deps.b.gauges.held(g.held)],
    })
    const w2 = workload(root, { requests: {}, gauges: { held: q(1.5, u.GB) } })
    const r2 = evaluate(scenario({ name: 'shared-gauge', root, workload: w2, pricing: list }))
    expect(poolOf(r2, 'log-vms')).toMatchObject({ count: 3, binding: 'memory' })
    expect(r2.total).toBeCloseTo(3 * H, 6)
  })
})

describe('params', () => {
  const ops = requestDim('t.param.ops')
  const sized = dimension('t.param.bytes', u.GB, 1)
  const fanout = param('fanout', q(2, u.one))
  const perCall = param('perCall', q(3, u.req))
  const leaf = offering('leaf', {
    requests: () => ({
      op: request({}, () => ({ bill: [bill(ops, perCall)] })),
      put: request({ bytes: u.byte }, (r) => ({ bill: [bill(sized, r.bytes)] })),
    }),
  })
  const root = service('root', {
    deps: { leaf },
    requests: ({ deps }) => ({
      go: request({}, () => ({ calls: [deps.leaf.op({}).times(fanout)] })),
      upload: request({ bytes: u.byte }, (r) => ({ calls: [deps.leaf.put({ bytes: r.bytes })] })),
    }),
  })
  const opsFor = (params: Record<string, number | ReturnType<typeof q<{ req: 1 }>>>) =>
    dimOf(
      evaluate(
        scenario({
          name: 'params',
          root,
          workload: workload(root, { requests: { go: { rate: rps(1), attrs: {} } }, params }),
          pricing: list,
        }),
      ),
      't.param.ops',
    ).usage

  it('uses defaults when the workload does not override them', () => {
    // 2 calls × 3 req = 6 per root request → 6M
    expect(opsFor({})).toBeCloseTo(6 * M, 3)
  })

  it('applies workload overrides in base units or as expressions', () => {
    expect(opsFor({ fanout: 5 })).toBeCloseTo(15 * M, 3) // 5 × 3
    expect(opsFor({ perCall: q(1, u.req) })).toBeCloseTo(2 * M, 3) // 2 × 1
    expect(opsFor({ fanout: 0.5, perCall: 4 })).toBeCloseTo(2 * M, 3) // 0.5 × 4
  })

  it('binds params used in workload attributes', () => {
    const w = workload(root, {
      requests: { upload: { rate: rps(1), attrs: { bytes: param('msg', q(1, u.KB)) } } },
      params: { msg: q(4, u.KB) },
    })
    const r = evaluate(scenario({ name: 'attr-param', root, workload: w, pricing: list }))
    // 4 KB × M = 10,512,000,000 B = 10.512 GB
    expect(dimOf(r, 't.param.bytes').usage).toBeCloseTo(10.512, 9)
  })
})

describe('cross-AZ edges', () => {
  const interAz = transferDim('t.xaz') // $0.01 per GB, each direction
  const edgeSvc = (name: string, pattern: EdgePattern) =>
    service(name, {
      requests: () => ({ send: request({ bytes: u.byte }, (r) => ({ net: [edge(r.bytes, pattern)] })) }),
    })
  const run = (pattern: EdgePattern, withInterAz = true) => {
    const s = edgeSvc('edge', pattern)
    const w = workload(s, { requests: { send: { rate: rps(1), attrs: { bytes: q(3, u.KB) } } } })
    return evaluate(scenario({ name: 'xaz', root: s, workload: w, pricing: list, ...(withInterAz ? { interAz } : {}) }))
  }

  it('uniformClients over 3 AZs: 2/3 of bytes cross, charged in both directions', () => {
    // 3000 B × 2/3 × 2 = 4000 B per request; × M = 10.512 GB → $0.10512
    const r = run({ kind: 'uniformClients', azs: 3 })
    expect(dimOf(r, 't.xaz').usage).toBeCloseTo(10.512, 9)
    expect(r.total).toBeCloseTo(0.10512, 9)
    expect(nodeAt(r.tree, ['edge', 'send', 'cross-az'])).toMatchObject({ kind: 'network' })
  })

  it('replicate rf=3: 2 copies cross, charged in both directions', () => {
    // 3000 B × 2 × 2 = 12,000 B per request; × M = 31.536 GB
    expect(dimOf(run({ kind: 'replicate', rf: 3 }), 't.xaz').usage).toBeCloseTo(31.536, 9)
  })

  it('sameAz and single-AZ edges cost nothing and need no interAz dimension', () => {
    expect(run({ kind: 'sameAz' }).dimensions).toEqual([])
    expect(run({ kind: 'sameAz' }, false).total).toBe(0)
    expect(run({ kind: 'uniformClients', azs: 1 }, false).total).toBe(0)
    expect(run({ kind: 'replicate', rf: 1 }, false).total).toBe(0)
  })

  it('errors when a crossing edge is declared but the scenario has no interAz dimension', () => {
    expect(() => run({ kind: 'uniformClients', azs: 3 }, false)).toThrow(/interAz/)
    expect(() => run({ kind: 'replicate', rf: 2 }, false)).toThrow(/interAz/)
  })

  it('scales edges in a dependency by the call multiplicity', () => {
    const child = edgeSvc('child', { kind: 'replicate', rf: 2 })
    const parent = service('parent', {
      deps: { child },
      requests: ({ deps }) => ({
        go: request({}, () => ({ calls: [deps.child.send({ bytes: q(1, u.KB) }).times(0.5)] })),
      }),
    })
    const w = workload(parent, { requests: { go: { rate: rps(1), attrs: {} } } })
    const r = evaluate(scenario({ name: 'xaz-mult', root: parent, workload: w, pricing: list, interAz }))
    // 0.5 × 1000 B × (rf-1 = 1) × 2 = 1000 B per request → M × 1000 B = 2.628 GB
    expect(dimOf(r, 't.xaz').usage).toBeCloseTo(2.628, 9)
    expect(leafPaths(r.tree)).toEqual(['parent/go/child/send/cross-az/t.xaz'])
  })

  it('needs no interAz dimension for an edge behind a call whose multiplicity is 0', () => {
    const child = edgeSvc('child', { kind: 'replicate', rf: 3 })
    const parent = service('parent', {
      deps: { child },
      requests: ({ deps }) => ({
        go: request({}, () => ({
          calls: [deps.child.send({ bytes: q(1, u.KB) }).times(param('replicated', q(1, u.one)))],
        })),
      }),
    })
    const w = workload(parent, { requests: { go: { rate: rps(1), attrs: {} } }, params: { replicated: 0 } })
    const r = evaluate(scenario({ name: 'xaz-off', root: parent, workload: w, pricing: list }))
    expect(r.total).toBe(0)
    expect(r.dimensions).toEqual([])
  })
})
