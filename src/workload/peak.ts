// How "peak" is defined for sizing (DESIGN.md §6.2): the maximum over time steps (default), or a
// percentile of the per-step values, to avoid sizing for short spikes.
import { docs } from '../docs/registry.ts'
export type PeakSpec = 'max' | { readonly percentile: number }

export const peakOf = (values: ArrayLike<number>, spec: PeakSpec = 'max'): number => {
  const n = values.length
  if (n === 0) return 0
  if (spec === 'max') {
    let m = -Infinity
    for (let i = 0; i < n; i++) m = Math.max(m, values[i]!)
    return m
  }
  const p = spec.percentile
  if (!(p > 0 && p <= 100)) throw new Error(`peak: percentile must be in (0, 100], got ${p}`)
  const sorted = Array.from(values).sort((a, b) => a - b)
  // nearest-rank percentile
  return sorted[Math.min(n - 1, Math.ceil((p / 100) * n) - 1)]!
}

docs([
  {
    name: 'peakOf',
    kind: 'function',
    module: 'pricesim',
    summary: "The peak of per-step values under a workload's `peak` spec: the maximum, or a nearest-rank percentile.",
    signature: "peakOf(values: ArrayLike<number>, spec?: 'max' | { percentile: number }): number",
    guidance: `
- \`'max'\` (default) is the largest value; \`{ percentile: p }\` is the nearest-rank percentile, \`p\` in (0, 100] (throws otherwise). Empty input gives 0.
- Set it on the workload (\`peak: { percentile: 99 }\`) rather than calling it: pools then size on that percentile of each resource's per-step demand.`,
    seeAlso: ['workload'],
    internal: true,
  },
])
