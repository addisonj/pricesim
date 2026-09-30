// Distributions for request attributes (DESIGN.md §7), e.g. a mix of message sizes. The engine draws a fixed
// number of seeded samples per request type (Monte Carlo), so non-linear expressions such as
// ceil(bytes / 1 KB) are costed correctly and results are reproducible.
import { Expr, q } from '../core/expr.ts'
import type { RDim } from '../core/dim.ts'
import type { Unit } from '../core/units.ts'
import { normal, type Rng } from './random.ts'
import { doc, docs } from '../docs/registry.ts'

export class Dist<D> {
  /** phantom: dimension of the sampled values */
  declare readonly __dim: (d: D) => D
  constructor(
    readonly describe: string,
    readonly dim: RDim,
    /** mean in base units */
    readonly mean: number,
    /** one sample in base units */
    readonly sample: (r: Rng) => number,
  ) {}

  /** a constant expression at the distribution's mean (used by closed forms) */
  meanExpr(): Expr<D> {
    return new Expr<D>({ k: 'const', v: this.mean }, this.dim)
  }
}

export const isDist = (x: unknown): x is Dist<any> => x instanceof Dist

export const dist = {
  /** always the same value */
  fixed: <D>(value: Expr<D>): Dist<D> => {
    const v = value.eval()
    return new Dist<D>(`fixed(${v})`, value.dim, v, () => v)
  },

  /** uniform between min and max */
  uniform: <D>(opts: { min: Expr<D>; max: Expr<D> }): Dist<D> => {
    const a = opts.min.eval()
    const b = opts.max.eval()
    if (!(b >= a)) throw new Error('dist.uniform: max must be >= min')
    return new Dist<D>(`uniform(${a}, ${b})`, opts.min.dim, (a + b) / 2, (r) => a + (b - a) * r.next())
  },

  /** discrete values with weights (normalized) */
  empirical: <D>(entries: readonly { value: Expr<D>; weight: number }[]): Dist<D> => {
    if (!entries.length) throw new Error('dist.empirical: needs at least one entry')
    const total = entries.reduce((a, e) => a + e.weight, 0)
    if (!(total > 0)) throw new Error('dist.empirical: weights must sum to > 0')
    const vs = entries.map((e) => ({ v: e.value.eval(), p: e.weight / total }))
    const mean = vs.reduce((a, x) => a + x.v * x.p, 0)
    return new Dist<D>(`empirical(${vs.length})`, entries[0]!.value.dim, mean, (r) => {
      let u = r.next()
      for (const x of vs) {
        if (u < x.p) return x.v
        u -= x.p
      }
      return vs[vs.length - 1]!.v
    })
  },

  /** log-normal from its median and 99th percentile (both in the same unit) */
  lognormal: <D>(opts: { median: Expr<D>; p99: Expr<D> }): Dist<D> => {
    const m = opts.median.eval()
    const p99 = opts.p99.eval()
    if (!(m > 0 && p99 >= m)) throw new Error('dist.lognormal: need 0 < median <= p99')
    const mu = Math.log(m)
    const sigma = Math.log(p99 / m) / 2.326347874
    return new Dist<D>(`lognormal(median=${m}, p99=${p99})`, opts.median.dim, Math.exp(mu + (sigma * sigma) / 2), (r) =>
      Math.exp(mu + sigma * normal(r)),
    )
  },
}

/** Convenience: a fixed distribution from a number in a unit. */
export const fixedIn = <D>(v: number, unit: Unit<D>): Dist<D> => dist.fixed(q(v, unit))

doc({
  name: 'dist',
  kind: 'const',
  module: 'pricesim',
  summary:
    'Distributions for request attributes (message sizes, items per call): `fixed`, `uniform`, `empirical`, `lognormal`.',
  signature: `dist.fixed(value: Expr<D>): Dist<D>
dist.uniform(opts: { min: Expr<D>; max: Expr<D> }): Dist<D>
dist.empirical(entries: { value: Expr<D>; weight: number }[]): Dist<D>
dist.lognormal(opts: { median: Expr<D>; p99: Expr<D> }): Dist<D>`,
  params: [
    { name: 'value', type: 'Expr<D>', doc: '`fixed`: the only value.' },
    { name: 'opts.min / opts.max', type: 'Expr<D>', doc: '`uniform`: bounds; throws unless max ≥ min.' },
    {
      name: 'entries',
      type: '{ value: Expr<D>; weight: number }[]',
      doc: '`empirical`: discrete values with relative weights (normalized). Throws if empty or if the weights do not sum to > 0.',
    },
    {
      name: 'opts.median / opts.p99',
      type: 'Expr<D>',
      doc: '`lognormal`: median and 99th percentile; throws unless 0 < median ≤ p99. The mean is above the median.',
    },
  ],
  returns:
    'A `Dist` (`mean` and `sample(rng)` in base units). Use it in place of an expression for a request attribute in `workload({ requests })`.',
  guidance: `
- **When to use:** the request body is non-linear in the attribute (\`ceil(bytes / 1 KB)\` request units, per-object minimum sizes). For linear bodies a fixed mean gives the same cost with no sampling noise.
- The engine draws \`samples\` values per request type (workload default 64, seeded by the workload's \`seed\`); each carries 1/samples of the requests. Results are reproducible; more samples, less noise.
- \`closedForm\` replaces a distribution by its mean and lists that in \`assumptions\`.
- \`sweep\`/\`withOverrides\` on \`<request>.<attr>\` replaces the distribution by the constant swept value.
- Values are evaluated when the distribution is built (no params or symbols).`,
  examples: [
    `import { dist, q, u } from 'pricesim'

// most payloads are small, a few are large
const payload = dist.lognormal({ median: q(1, u.KB), p99: q(64, u.KB) })
const mix = dist.empirical([
  { value: q(0.5, u.KB), weight: 3 },
  { value: q(8, u.KB), weight: 1 },
])
const pageSize = dist.uniform({ min: q(10, u.count), max: q(50, u.count) })`,
  ],
  seeAlso: ['workload', 'fixedIn', 'Dist'],
  guide: 'workloads',
})

docs([
  {
    name: 'Dist',
    kind: 'class',
    module: 'pricesim',
    summary:
      'A distribution of values in one dimension: `describe`, `dim`, `mean` and `sample(rng)` in base units, `meanExpr()`.',
    guidance:
      '- Build one with `dist.*` or `fixedIn`; the constructor is for custom distributions (`sample` must return base units).',
    seeAlso: ['dist'],
  },
  { name: 'isDist', kind: 'function', module: 'pricesim', summary: 'Whether a value is a `Dist`.', internal: true },
  {
    name: 'fixedIn',
    kind: 'function',
    module: 'pricesim',
    summary: 'Shorthand for `dist.fixed(q(v, unit))`.',
    signature: 'fixedIn(v: number, unit: Unit<D>): Dist<D>',
    seeAlso: ['dist'],
  },
])
