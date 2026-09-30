// Units: a dimension plus a scale to base units. Types track the dimension only, so KB/GB/GiB are all
// `{ byte: 1 }` and are converted at runtime.
import { doc, docs } from '../docs/registry.ts'
import { BASE_DIMS, combine, sameDim, showDim, UnitError, type Div, type Mul, type RDim } from './dim.ts'

export class Unit<D> {
  /** phantom field: makes D invariant so extra exponents are never silently accepted */
  declare readonly __dim: (d: D) => D
  constructor(
    readonly name: string,
    /** multiply a value in this unit by `scale` to get base units */
    readonly scale: number,
    readonly dim: RDim,
  ) {}

  mul<E>(o: Unit<E>): Unit<Mul<D, E>> {
    return new Unit(`${this.name}*${o.name}`, this.scale * o.scale, combine(this.dim, o.dim, 1))
  }

  div<E>(o: Unit<E>): Unit<Div<D, E>> {
    const denom = o.name.includes('*') || o.name.includes('/') ? `(${o.name})` : o.name
    return new Unit(`${this.name}/${denom}`, this.scale / o.scale, combine(this.dim, o.dim, -1))
  }

  toString(): string {
    return this.name
  }
}

doc({
  name: 'Unit',
  kind: 'class',
  module: 'pricesim',
  summary:
    'A unit of measure: a name, a dimension, and a scale to base units. Get them from `u`, or build them with `.mul`/`.div`.',
  signature:
    'class Unit<D> { readonly name: string; readonly scale: number; readonly dim: RDim; mul(o: Unit): Unit; div(o: Unit): Unit }',
  guidance: `
- \`D\` is the dimension as a type, e.g. \`Unit<{ byte: 1; s: -1 }>\` for \`u.GB.div(u.s)\`. The type tracks the dimension only: KB, GB and GiB are all \`Unit<{ byte: 1 }>\` and are converted at runtime through \`scale\`.
- \`scale\` is the size of one unit in base units (USD, s, byte, req, op, millicore, count): \`u.GB.scale\` is 1e9, \`u.hour.scale\` is 3600.
- \`.mul\`/\`.div\` compose units and their names: \`u.USD.div(u.GB.mul(u.month))\` is named \`USD/(GB*month)\`.
- Units are only used to build quantities (\`q\`, \`sym\`), to read values out (\`expr.in(unit)\`), to check dimensions (\`expr.as(unit)\`) and as a billing dimension's usage unit. Arithmetic happens on \`Expr\`, not on units.`,
  examples: [
    `import { q, u } from 'pricesim'

const perGbMonth = u.USD.div(u.GB.mul(u.month))
const storage = q(0.08, perGbMonth).mul(q(4, u.TiB)).mul(q(1, u.month))
storage.in(u.USD) // ≈ 351.8`,
  ],
  seeAlso: ['u', 'q', 'baseUnit', 'parseUnit'],
  guide: 'units',
})

const unit = <D>(name: string, dim: RDim, scale = 1): Unit<D> => new Unit<D>(name, scale, dim)

const HOUR = 3600
/** billing month: 730 hours */
export const MONTH_SECONDS = 730 * HOUR

type Money = { USD: 1 }
type Time = { s: 1 }
type Bytes = { byte: 1 }
type ByteRate = { byte: 1; s: -1 }

export const u = {
  one: unit<{}>('1', {}),
  percent: unit<{}>('%', {}, 0.01),

  USD: unit<Money>('USD', { USD: 1 }),

  s: unit<Time>('s', { s: 1 }),
  ms: unit<Time>('ms', { s: 1 }, 1e-3),
  minute: unit<Time>('minute', { s: 1 }, 60),
  hour: unit<Time>('hour', { s: 1 }, HOUR),
  day: unit<Time>('day', { s: 1 }, 24 * HOUR),
  month: unit<Time>('month', { s: 1 }, MONTH_SECONDS),
  year: unit<Time>('year', { s: 1 }, 12 * MONTH_SECONDS),

  byte: unit<Bytes>('byte', { byte: 1 }),
  KB: unit<Bytes>('KB', { byte: 1 }, 1e3),
  MB: unit<Bytes>('MB', { byte: 1 }, 1e6),
  GB: unit<Bytes>('GB', { byte: 1 }, 1e9),
  TB: unit<Bytes>('TB', { byte: 1 }, 1e12),
  KiB: unit<Bytes>('KiB', { byte: 1 }, 1024),
  MiB: unit<Bytes>('MiB', { byte: 1 }, 1024 ** 2),
  GiB: unit<Bytes>('GiB', { byte: 1 }, 1024 ** 3),
  TiB: unit<Bytes>('TiB', { byte: 1 }, 1024 ** 4),

  Mbps: unit<ByteRate>('Mbps', { byte: 1, s: -1 }, 1e6 / 8),
  Gbps: unit<ByteRate>('Gbps', { byte: 1, s: -1 }, 1e9 / 8),

  req: unit<{ req: 1 }>('req', { req: 1 }),
  op: unit<{ op: 1 }>('op', { op: 1 }),
  millicore: unit<{ millicore: 1 }>('millicore', { millicore: 1 }),
  vCPU: unit<{ millicore: 1 }>('vCPU', { millicore: 1 }, 1000),
  count: unit<{ count: 1 }>('count', { count: 1 }),
} as const

doc({
  name: 'u',
  kind: 'const',
  module: 'pricesim',
  summary: 'The built-in units, by name: money, time, bytes, bit rates, requests, operations, CPU and counts.',
  signature:
    'const u: { one, percent, USD, s, ms, minute, hour, day, month, year, byte, KB, …, TiB, Mbps, Gbps, req, op, millicore, vCPU, count }',
  guidance: `
- **Dimensionless:** \`one\` (named \`1\`) and \`percent\` (scale 0.01, so \`q(50, u.percent)\` evaluates to 0.5).
- **Money:** \`USD\`.
- **Time:** \`s\`, \`ms\`, \`minute\`, \`hour\`, \`day\`, \`month\` = 730 hours (the billing month; \`MONTH_SECONDS\`), \`year\` = 12 months = 365 days.
- **Bytes:** decimal \`KB\`, \`MB\`, \`GB\`, \`TB\` (powers of 1000) and binary \`KiB\`, \`MiB\`, \`GiB\`, \`TiB\` (powers of 1024), over base \`byte\`. AWS prices per GB are decimal GB; instance memory is usually GiB.
- **Bit rates:** \`Mbps\`, \`Gbps\` are byte/s with bits converted (\`q(1, u.Gbps).in(u.MB.div(u.s))\` is 125).
- **Work:** \`req\` (requests, what request types are counted in), \`op\` (e.g. IOPS), \`millicore\` and \`vCPU\` (1000 millicores), \`count\` (instances, items, anything counted).
- Build compound units with \`.mul\`/\`.div\`, e.g. \`u.req.div(u.s)\`, \`u.vCPU.mul(u.ms)\`. For other quantities (streams, partitions, messages) create a base unit with \`baseUnit\` rather than reusing \`count\`, so they can't be mixed up.`,
  examples: [
    `import { q, u } from 'pricesim'

const perSecond = u.req.div(u.s)
const rate = q(5000, perSecond)
rate.in(u.req.div(u.minute)) // 300000
q(1, u.GiB).in(u.MiB) // 1024`,
  ],
  seeAlso: ['Unit', 'q', 'baseUnit', 'defineUnit', 'MONTH_SECONDS'],
  guide: 'units',
})

export type UnitName = keyof typeof u

/** units created with baseUnit()/defineUnit(), by name, so unit strings can refer to them */
const registry = new Map<string, Unit<unknown>>()

/**
 * A new base dimension, e.g. `const stream = baseUnit('stream')` → `Unit<{ stream: 1 }>`. The type system tracks
 * it by name like the built-ins (products, quotients and mismatches type-check), and the runtime recognizes it
 * by name: calling baseUnit with the same name again (from any module) gives the same dimension, and unit
 * strings such as 'stream/s' parse once it has been created. Names of built-in dimensions or units are rejected.
 */
export const baseUnit = <N extends string>(name: N): Unit<{ [K in N]: 1 }> => {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new UnitError(`baseUnit: invalid name '${name}'`)
  if ((BASE_DIMS as readonly string[]).includes(name) || name in u) {
    throw new UnitError(`baseUnit: '${name}' is a built-in dimension or unit`)
  }
  const existing = registry.get(name)
  if (existing) {
    // a name registered by defineUnit is a scaled unit of another dimension, not a base unit
    if (existing.scale !== 1 || !sameDim(existing.dim, { [name]: 1 })) {
      throw new UnitError(`baseUnit: '${name}' is already defined as a unit of ${showDim(existing.dim)} (defineUnit)`)
    }
    return existing as Unit<{ [K in N]: 1 }>
  }
  const created = new Unit<{ [K in N]: 1 }>(name, 1, { [name]: 1 })
  registry.set(name, created as Unit<unknown>)
  return created
}

/**
 * Register a named unit (e.g. a scaled custom unit, `defineUnit('kstream', stream, 1000)`) so unit strings can
 * use it. Returns the unit, typed like `of`.
 */
export const defineUnit = <D>(name: string, of: Unit<D>, scale = 1): Unit<D> => {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new UnitError(`defineUnit: invalid name '${name}'`)
  const prev = registry.get(name)
  if (name in u || (prev && (prev.scale !== of.scale * scale || !sameDim(prev.dim, of.dim)))) {
    throw new UnitError(`defineUnit: '${name}' is already defined differently`)
  }
  const created = new Unit<D>(name, of.scale * scale, of.dim)
  registry.set(name, created as Unit<unknown>)
  return created
}

/**
 * Parse a unit string (untyped boundary: CLI, JSON, generated data).
 * Grammar: `a*b*c` or `a*b/c*d` or `a/(c*d)`; names are keys of `u` ('1' is dimensionless).
 */
export const parseUnit = (s: string): Unit<unknown> => {
  const lookup = (name: string): Unit<unknown> => {
    const key = name === '1' ? 'one' : name
    const found = (u as Record<string, Unit<unknown>>)[key] ?? registry.get(key)
    if (!found) {
      throw new UnitError(`unknown unit '${name}' (custom units must be created with baseUnit/defineUnit first)`)
    }
    return found
  }
  const product = (part: string): Unit<unknown> =>
    part
      .replace(/^\((.*)\)$/, '$1')
      .split('*')
      .map((p) => lookup(p.trim()))
      .reduce((a, b) => a.mul(b) as Unit<unknown>)
  const slash = s.indexOf('/')
  const unitV = slash < 0 ? product(s) : (product(s.slice(0, slash)).div(product(s.slice(slash + 1))) as Unit<unknown>)
  return new Unit(s.trim(), unitV.scale, unitV.dim)
}

doc({
  name: 'baseUnit',
  kind: 'function',
  module: 'pricesim',
  summary: "A new base dimension of your own, e.g. `baseUnit('stream')` → `Unit<{ stream: 1 }>`.",
  signature: 'baseUnit(name: string): Unit<{ [name]: 1 }>',
  params: [
    {
      name: 'name',
      type: 'string',
      doc: 'Letters, digits and `_`, starting with a letter. Must not be a built-in dimension or a key of `u` (`byte`, `GB`, … throw).',
    },
  ],
  returns:
    "A unit of scale 1 whose dimension is `{ [name]: 1 }`. Use it like a built-in unit: `q(3, stream)`, `u.byte.div(stream)`, `sym('streams', stream)`.",
  guidance: `
- Use it for quantities the built-ins don't cover (streams, partitions, messages, tenants), so the type checker keeps them apart: adding streams to partitions is a compile error and a runtime \`UnitError\`.
- The dimension is tracked by name, at the type level and at runtime. Calling \`baseUnit\` again with the same name, from any module, returns the same unit.
- After it has been called, unit strings can use the name: \`parseQuantity('5 stream/s')\`. Parsing before the call throws "unknown unit".
- For a scaled variant (1000 streams) use \`defineUnit\`.`,
  examples: [
    `import { baseUnit, q, u } from 'pricesim'

const stream = baseUnit('stream')
const partition = baseUnit('partition')
const perPartition = q(10_000, stream.div(partition))
const streams = perPartition.mul(q(24, partition)) // Expr<{ stream: 1 }>
streams.in(stream) // 240000
const ingest = q(2, u.KB.div(u.s).div(stream)).mul(streams) // Expr<byte/s>`,
  ],
  seeAlso: ['defineUnit', 'u', 'parseQuantity'],
  guide: 'units',
})

doc({
  name: 'defineUnit',
  kind: 'function',
  module: 'pricesim',
  summary:
    "Register a named, optionally scaled unit so unit strings can use it, e.g. `defineUnit('kstream', stream, 1000)`.",
  signature: 'defineUnit(name: string, of: Unit<D>, scale?: number): Unit<D>',
  params: [
    { name: 'name', type: 'string', doc: 'The name unit strings will use. Must not be a key of `u`.' },
    { name: 'of', type: 'Unit<D>', doc: 'The unit it is a multiple of; the new unit has its dimension.' },
    { name: 'scale', type: 'number', optional: true, default: '1', doc: 'How many `of` one new unit is.' },
  ],
  returns: 'The new unit, typed with the dimension of `of` (so `q(2, kstream).in(stream)` is 2000).',
  guidance: `
- Only needed when the unit must be reachable by name (\`parseUnit\`, \`parseQuantity\`, model files, the CLI). In code, \`q(2000, stream)\` works without it.
- Calling it again with the same name and the same scale is allowed; a different scale throws \`UnitError\`.
- Names follow the same rules as \`baseUnit\` names and share its namespace: redefining a name with a different scale or dimension throws, and so does \`baseUnit\` on a name \`defineUnit\` registered.`,
  examples: [
    `import { baseUnit, defineUnit, parseQuantity, q } from 'pricesim'

const stream = baseUnit('stream')
const kstream = defineUnit('kstream', stream, 1000)
q(2, kstream).in(stream) // 2000
parseQuantity('3 kstream').as(stream).eval() // 3000`,
  ],
  seeAlso: ['baseUnit', 'parseUnit'],
  guide: 'units',
})

doc({
  name: 'parseUnit',
  kind: 'function',
  module: 'pricesim',
  summary: "Parse a unit string such as 'GB/s' or 'USD/(GB*month)' at an untyped boundary (CLI, JSON, generated data).",
  signature: 'parseUnit(s: string): Unit<unknown>',
  params: [
    {
      name: 's',
      type: 'string',
      doc: 'Names joined by `*`, with at most one `/`. Names are keys of `u` (`1` for dimensionless, `percent` rather than `%`) or units made with `baseUnit`/`defineUnit`.',
    },
  ],
  returns: 'A `Unit<unknown>` named `s`; narrow values built from it with `expr.as(unit)`.',
  guidance: `
- Everything after the \`/\` is the denominator: \`USD/GB*month\` means \`USD/(GB*month)\`; parentheses around either side are optional.
- Only one \`/\`: \`GB/s/s\` throws. There are no exponents; write \`s*s\`.
- Unknown names throw \`UnitError\` ("unknown unit"); custom units must be created first.
- In code, prefer \`u.GB.div(u.s)\`: it is typed.`,
  examples: [
    `import { parseUnit, u } from 'pricesim'

const rate = parseUnit('USD/(GB*month)')
rate.scale === u.USD.div(u.GB.mul(u.month)).scale // true`,
  ],
  seeAlso: ['parseQuantity', 'u', 'baseUnit'],
  guide: 'units',
})

docs([
  {
    name: 'MONTH_SECONDS',
    kind: 'const',
    module: 'pricesim',
    summary: 'Seconds in a billing month: 730 hours (2,628,000 s), the length of `u.month`.',
    guidance: `
- Monthly figures (tiers, reports) are normalized to this month, not to a calendar month.`,
    seeAlso: ['u'],
    guide: 'units',
  },
  {
    name: 'UnitName',
    kind: 'type',
    module: 'pricesim',
    summary: "The names of the built-in units, `keyof typeof u` ('GB', 'hour', …).",
    internal: true,
  },
])
