// Seeded randomness (DESIGN.md §7): every sample is reproducible from a seed.
import { docs } from '../docs/registry.ts'

/** A seeded PRNG producing uniform numbers in [0, 1). */
export interface Rng {
  next(): number
  /** an independent stream derived from this one and a label */
  fork(label: string): Rng
}

/** 32-bit string hash (FNV-1a) for deriving seeds from labels. */
export const hashString = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: small, fast, good enough for Monte Carlo cost modeling (not cryptography). */
export const rng = (seed: number): Rng => {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, fork: (label) => rng((seed ^ hashString(label)) >>> 0) }
}

/** Standard normal via Box–Muller. */
export const normal = (r: Rng): number => {
  let u = 0
  while (u === 0) u = r.next()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r.next())
}

/** Zipf weights for ranks 1..n with exponent s (normalized to sum to 1). */
export const zipfWeights = (n: number, s = 1): number[] => {
  const w = Array.from({ length: n }, (_, i) => 1 / (i + 1) ** s)
  const total = w.reduce((a, x) => a + x, 0)
  return w.map((x) => x / total)
}

docs([
  {
    name: 'rng',
    kind: 'function',
    module: 'pricesim',
    summary: 'A seeded pseudo-random stream (mulberry32): `next()` in [0, 1), `fork(label)` for an independent stream.',
    signature: 'rng(seed: number): Rng',
    returns:
      '`{ next(): number; fork(label: string): Rng }`. The same seed gives the same sequence; `fork` derives a stream from the seed and the label, so it does not depend on how many numbers were drawn before.',
    guidance: `
- Model code rarely needs it: \`simulateTenants\` hands each tenant a forked stream, and distribution sampling uses the workload's \`seed\`.
- Not for cryptography.`,
    seeAlso: ['simulateTenants', 'dist'],
    guide: 'workloads',
  },
  {
    name: 'zipfWeights',
    kind: 'function',
    module: 'pricesim',
    summary: 'Zipf weights for ranks 1..n with exponent s (weight ∝ 1/rank^s), normalized to sum to 1.',
    signature: 'zipfWeights(n: number, s?: number): number[]',
    params: [
      { name: 'n', type: 'number', doc: 'Number of ranks.' },
      { name: 's', type: 'number', optional: true, default: '1', doc: 'Exponent; larger is more skewed.' },
    ],
    returns: 'An array of n weights, largest first.',
    seeAlso: ['zipfTenants'],
  },
  {
    name: 'hashString',
    kind: 'function',
    module: 'pricesim',
    summary: '32-bit FNV-1a hash of a string (derives seeds from labels).',
    internal: true,
  },
  {
    name: 'normal',
    kind: 'function',
    module: 'pricesim',
    summary: 'A standard normal draw from an `Rng` (Box–Muller).',
    internal: true,
  },
])
