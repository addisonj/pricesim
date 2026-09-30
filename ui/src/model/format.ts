// Number formatting for costs, shares and quantities in base units.

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/** USD, cents below $10k */
export const money = (v: number): string => (Math.abs(v) >= 10_000 ? usd0 : usd).format(v)

/** USD, compact ($1.2k, $3.4M) for axes and tight labels */
export const moneyShort = (v: number): string => {
  const a = Math.abs(v)
  if (a >= 1e6) return `$${(v / 1e6).toPrecision(3)}M`
  if (a >= 1e3) return `$${(v / 1e3).toPrecision(3)}k`
  return `$${a >= 10 ? v.toFixed(0) : v.toFixed(2)}`
}

export const pct = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : `${(v * 100).toFixed(digits)}%`

/** a plain number with ~4 significant digits and thousands separators */
export const num = (v: number): string => {
  if (!Number.isFinite(v)) return String(v)
  const a = Math.abs(v)
  if (a !== 0 && (a < 1e-3 || a >= 1e15)) return v.toExponential(2)
  const digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4
  return v.toLocaleString('en-US', { maximumFractionDigits: digits })
}

const SI = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
] as const

const si = (v: number, unit: string): string => {
  for (const [f, p] of SI) if (Math.abs(v) >= f) return `${num(v / f)} ${p}${unit}`
  return `${num(v)} ${unit}`
}

/** A value in base units, scaled to a readable unit where the base unit is known. */
export const quantity = (v: number, unit: string): string => {
  switch (unit) {
    case 'byte':
      return si(v, 'B').replace(' kB', ' KB')
    case 'byte/s':
      return si(v, 'B/s').replace(' kB', ' KB')
    case 'millicore':
      return `${num(v / 1000)} vCPU`
    case 's':
      return v >= 86400 ? `${num(v / 86400)} d` : v >= 3600 ? `${num(v / 3600)} h` : `${num(v)} s`
    case '':
      return num(v)
    case '×':
      return `×${num(v)}`
    default:
      return `${num(v)} ${unit}`
  }
}
