// Capacity (DESIGN.md §8 `capacity`): the largest load a fixed deployment sustains.
//
// Holds the given pools at fixed sizes and scales request rates (all of them, or a chosen subset) by a factor
// k until some fixed pool would need more than its size. Sizing is monotone in the rates, so k is found by
// bisection on the numeric engine; the result names the pool and resource that bind first.
import { evaluate, type Result } from './evaluate.ts'
import { singleWorkload, type Scenario } from './scenario.ts'
import { withOverrides } from './sweep.ts'
import { meanRateBindings } from '../workload/workload.ts'
import { doc } from '../docs/registry.ts'

export interface CapacityOptions {
  /** pool name → fixed size (instances, pods or nodes) */
  readonly fix: Readonly<Record<string, number>>
  /** request types whose rates are scaled (default: every request in the workload) */
  readonly scale?: readonly string[]
  /** relative precision of the factor (default 1e-4) */
  readonly tolerance?: number
}

export interface CapacityResult {
  /** multiple of the scenario's rates the fixed pools sustain */
  readonly factor: number
  /** mean req/s per scaled request at that factor */
  readonly rates: Readonly<Record<string, number>>
  /** the fixed pool that runs out first, and the resource it runs out of */
  readonly binding: { readonly pool: string; readonly resource: string }
  /** the evaluation at the capacity point */
  readonly result: Result
}

export const capacity = (s: Scenario, opts: CapacityOptions): CapacityResult => {
  const means = meanRateBindings(singleWorkload(s, 'capacity'))
  const names = opts.scale ?? Object.keys(means).map((k) => k.slice('rate.'.length))
  for (const n of names) if (!(`rate.${n}` in means)) throw new Error(`capacity: no request '${n}' in the workload`)
  const tol = opts.tolerance ?? 1e-4

  const at = (k: number) => {
    const point = Object.fromEntries(names.map((n) => [`rate.${n}`, means[`rate.${n}`]! * k]))
    return evaluate(withOverrides(s, point))
  }
  const fits = (r: Result) => {
    for (const [pool, size] of Object.entries(opts.fix)) {
      const p = r.pools.find((x) => x.name === pool)
      if (!p) throw new Error(`capacity: no pool '${pool}' (pools: ${r.pools.map((x) => x.name).join(', ')})`)
      if (p.min > size) throw new Error(`capacity: '${pool}' is fixed at ${size}, below its minimum of ${p.min}`)
      if (p.count > size) return false
    }
    return true
  }

  if (!fits(at(0))) throw new Error('capacity: the fixed pools do not fit even with no traffic (gauge-driven demand)')
  let lo = 0
  let hi = 1
  while (fits(at(hi))) {
    lo = hi
    hi *= 2
    if (hi > 1e12) throw new Error('capacity: unbounded (the fixed pools are not used by the scaled requests)')
  }
  while ((hi - lo) / hi > tol) {
    const mid = (lo + hi) / 2
    if (fits(at(mid))) lo = mid
    else hi = mid
  }

  // the pool that overflows just above capacity is the binding one
  const over = at(hi)
  const bindingPool = Object.entries(opts.fix).find(
    ([pool, size]) => over.pools.find((p) => p.name === pool)!.count > size,
  )!
  const binding = { pool: bindingPool[0], resource: over.pools.find((p) => p.name === bindingPool[0])!.binding }

  return {
    factor: lo,
    rates: Object.fromEntries(names.map((n) => [n, means[`rate.${n}`]! * lo])),
    binding,
    result: at(lo),
  }
}

doc({
  name: 'capacity',
  kind: 'function',
  module: 'pricesim',
  summary: "The largest multiple of the workload's request rates that pools held at fixed sizes can sustain.",
  signature:
    'capacity(s: Scenario, opts: { fix: Record<string, number>; scale?: string[]; tolerance?: number }): CapacityResult',
  params: [
    { name: 's', type: 'Scenario', doc: 'A single-workload scenario; its rates are the 1× point.' },
    {
      name: 'opts.fix',
      type: 'Record<string, number>',
      doc: "Pool name → fixed size: instances (instance pool), replicas (pod group) or nodes (node pool). A size below the pool's minimum throws, as does an unknown pool name.",
    },
    {
      name: 'opts.scale',
      type: 'string[]',
      optional: true,
      default: 'every request in the workload',
      doc: 'Root request types whose rates are scaled; the others stay at their scenario rates.',
    },
    {
      name: 'opts.tolerance',
      type: 'number',
      optional: true,
      default: '1e-4',
      doc: 'Relative precision of the factor.',
    },
  ],
  returns: `A \`CapacityResult\`:
- \`factor\`: the multiple of the scenario's rates at which every fixed pool still fits (the pool's computed size is ≤ its fixed size); may be below 1 if the deployment is already too small.
- \`rates\`: mean req/s per scaled request at that factor.
- \`binding\`: \`{ pool, resource }\`, the fixed pool that overflows first just above \`factor\`, and the resource that sizes it.
- \`result\`: the full \`evaluate\` result at \`factor\`.`,
  guidance: `
- Rates are scaled by rescaling each series (shape kept), so peaks scale with the means; gauges derived from rates scale too, fixed gauge levels do not.
- The factor is found by doubling, then bisection, on full evaluations; it assumes a pool's size never falls as rates rise.
- Throws when the fixed pools do not fit even with no traffic (gauge-driven demand), or when the scaled requests do not use them (unbounded).
- Pools not in \`fix\` are sized freely, as in \`evaluate\`.
- CLI: \`pricesim capacity model.ts --fix api=10[,db=3] [--scale upload]\`.`,
  examples: [
    `import { capacity, pricing, q, scenario, series, u, workload } from 'pricesim'
import { instancePool, request, service } from 'pricesim/model'
import { ec2 } from 'pricesim/aws'

const web = instancePool('web', { instance: ec2['c7g.large'], min: 2, loadFactor: 0.7, azs: 2 })
const api = service('api', {
  pools: { web },
  requests: ({ pools }) => ({
    get: request({}, () => ({ use: [pools.web.cpu(q(5, u.vCPU.mul(u.ms)))] })),
  }),
})
const s = scenario({
  name: 'api',
  root: api,
  pricing: pricing(),
  workload: workload(api, {
    requests: { get: { rate: series.diurnal({ mean: q(500, u.req.div(u.s)), peakToMean: 1.5 }), attrs: {} } },
  }),
})

// how far do 4 web instances go?
const c = capacity(s, { fix: { web: 4 } })
console.log(c.factor, c.rates.get, c.binding) // ≈1.5, ≈745 req/s, { pool: 'web', resource: 'cpu' }`,
  ],
  seeAlso: ['evaluate', 'sweep', 'instancePool'],
  guide: 'analysis',
})
