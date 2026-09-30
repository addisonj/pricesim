// Time series for workload rates (DESIGN.md §7). A series maps a time (seconds from period start) to a
// value in base units.
import type { Bindings, Expr } from '../core/expr.ts'
import { doc } from '../docs/registry.ts'

export interface Series<D> {
  /** phantom: dimension of the series values */
  readonly __dim?: (d: D) => D
  readonly describe: string
  at(tSeconds: number): number
  /**
   * The same series with its expressions evaluated under `bindings` (the workload's params). `workload()` and
   * sweeps call it, so a `param(…)` in a series follows the workload's `params`.
   */
  readonly resolve?: (bindings: Bindings) => Series<D>
}

/** A series whose values come from expressions: built with no bindings, re-built by `resolve`. */
const resolvable = <D>(build: (b: Bindings) => { describe: string; at: (t: number) => number }): Series<D> => {
  const make = (b: Bindings): Series<D> => ({ ...build(b), resolve: make })
  return make({})
}

export const series = {
  constant: <D>(value: Expr<D>): Series<D> =>
    resolvable((b) => {
      const v = value.eval(b)
      return { describe: `constant(${v})`, at: () => v }
    }),
  /**
   * Daily sine wave with the given mean; peak = mean × peakToMean (1 ≤ peakToMean ≤ 2 keeps it non-negative).
   * The peak is at `peakHour` (UTC hour of day).
   */
  diurnal: <D>(opts: { mean: Expr<D>; peakToMean: number; peakHour?: number }): Series<D> => {
    const amp = opts.peakToMean - 1
    if (amp < 0 || amp > 1) throw new Error('diurnal: peakToMean must be between 1 and 2')
    const peakHour = opts.peakHour ?? 18
    return resolvable((b) => {
      const mean = opts.mean.eval(b)
      return {
        describe: `diurnal(mean=${mean}, peakToMean=${opts.peakToMean})`,
        at: (t) => mean * (1 + amp * Math.cos((2 * Math.PI * (t / 3600 - peakHour)) / 24)),
      }
    })
  },
  fromArray: <D>(values: readonly Expr<D>[], stepSeconds: number): Series<D> =>
    resolvable((b) => {
      const vs = values.map((v) => v.eval(b))
      return {
        describe: `array(${vs.length})`,
        at: (t) => vs[Math.min(vs.length - 1, Math.floor(t / stepSeconds))] ?? 0,
      }
    }),
}

doc({
  name: 'series',
  kind: 'const',
  module: 'pricesim',
  summary: 'Rate series for workloads: `series.constant`, `series.diurnal`, `series.fromArray`.',
  signature: `series.constant(value: Expr<D>): Series<D>
series.diurnal(opts: { mean: Expr<D>; peakToMean: number; peakHour?: number }): Series<D>
series.fromArray(values: Expr<D>[], stepSeconds: number): Series<D>`,
  params: [
    { name: 'value', type: 'Expr<req/s>', doc: '`constant`: the value at every time.' },
    { name: 'opts.mean', type: 'Expr<req/s>', doc: '`diurnal`: the nominal mean of the sine wave.' },
    {
      name: 'opts.peakToMean',
      type: 'number',
      doc: '`diurnal`: peak ÷ mean, from 1 (flat) to 2 (trough at 0). Outside [1, 2] it throws.',
    },
    {
      name: 'opts.peakHour',
      type: 'number',
      optional: true,
      default: '18',
      doc: '`diurnal`: hour of day (from the period start, read as UTC) at which the wave peaks.',
    },
    { name: 'values', type: 'Expr<req/s>[]', doc: '`fromArray`: one value per step.' },
    {
      name: 'stepSeconds',
      type: 'number',
      doc: '`fromArray`: seconds each value lasts. After the last value, the last one holds.',
    },
  ],
  returns:
    'A `Series` (`at(tSeconds)` in base units, plus a `describe` string). Use it as the `rate` of a request load in `workload(…)`.',
  guidance: `
- The engine samples a series at the midpoint of each workload step (hourly by default). Capacity is sized on the peak of those samples (see the workload's \`peak\`); usage is the sum over steps.
- \`diurnal\` is \`mean × (1 + (peakToMean − 1) × cos(2π(t/3600 − peakHour)/24))\`. A 730 h month is not a whole number of days, so its mean over the period is slightly off the nominal \`mean\` (about 0.5% in the tests).
- Values are evaluated when the series is built, without bindings: a \`param(…)\` takes its default (workload \`params\` do not reach it), and an unbound symbol throws.
- Series are not limited to rates, but the workload only uses them as request rates.
- To change the mean rate in an analysis, use \`sweep\` / \`withOverrides\` with \`rate.<request>\`: they rescale the series, keeping its shape.`,
  examples: [
    `import { q, series, u } from 'pricesim'

const perSecond = u.req.div(u.s)
const steady = series.constant(q(50, perSecond))
// averages ~200 req/s, peaks at 300 req/s at 18:00
const daily = series.diurnal({ mean: q(200, perSecond), peakToMean: 1.5 })
// a launch: 10/s for the first day, then 100/s
const launch = series.fromArray([q(10, perSecond), q(100, perSecond)], 86400)`,
  ],
  seeAlso: ['workload', 'seriesMean', 'sweep'],
  guide: 'workloads',
})
