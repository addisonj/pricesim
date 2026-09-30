// Symbolic expressions with dimensions. Our AST is the source of truth; the CAS bridge (cas.ts, later)
// converts to mathjs only to simplify and print. See DESIGN.md §4.
import { doc, docs } from '../docs/registry.ts'
import { assertSameDim, combine, UnitError, type Div, type Mul, type RDim, type Same } from './dim.ts'
import { parseUnit, u, type Unit } from './units.ts'

export type Node =
  | { readonly k: 'const'; readonly v: number } // value in base units
  | { readonly k: 'sym'; readonly name: string }
  | { readonly k: 'param'; readonly name: string; readonly def: Node }
  | { readonly k: 'bin'; readonly op: '+' | '-' | '*' | '/'; readonly a: Node; readonly b: Node }
  | { readonly k: 'fn'; readonly name: 'max' | 'min' | 'ceil' | 'floor'; readonly args: readonly Node[] }
  | {
      readonly k: 'opaque'
      readonly name: string
      readonly inputs: Readonly<Record<string, Node>>
      readonly fn: (v: Record<string, number>) => number
    }

/** Values for symbols/params, in base units (numbers) or as expressions. */
export type Bindings = Readonly<Record<string, number | Expr<any>>>

export class Expr<D> {
  /** phantom field: makes D invariant so extra exponents are never silently accepted */
  declare readonly __dim: (d: D) => D
  constructor(
    readonly node: Node,
    readonly dim: RDim,
  ) {}

  mul(n: number): Expr<D>
  mul<E>(o: Expr<E>): Expr<Mul<D, E>>
  mul(o: number | Expr<any>): Expr<any> {
    const r = lift(o)
    return new Expr({ k: 'bin', op: '*', a: this.node, b: r.node }, combine(this.dim, r.dim, 1))
  }

  div(n: number): Expr<D>
  div<E>(o: Expr<E>): Expr<Div<D, E>>
  div(o: number | Expr<any>): Expr<any> {
    const r = lift(o)
    return new Expr({ k: 'bin', op: '/', a: this.node, b: r.node }, combine(this.dim, r.dim, -1))
  }

  add<E>(o: Expr<E> & Same<D, E>): Expr<D> {
    return new Expr({ k: 'bin', op: '+', a: this.node, b: o.node }, assertSameDim(this.dim, o.dim, '+'))
  }

  sub<E>(o: Expr<E> & Same<D, E>): Expr<D> {
    return new Expr({ k: 'bin', op: '-', a: this.node, b: o.node }, assertSameDim(this.dim, o.dim, '-'))
  }

  /** Checked boundary: verify the dimension at runtime and narrow the static type. */
  as<E>(target: Unit<E>): Expr<E> {
    assertSameDim(this.dim, target.dim, `as(${target.name})`)
    return this as unknown as Expr<E>
  }

  /** Evaluate numerically in base units. */
  eval(bindings: Bindings = {}): number {
    return evalNode(this.node, bindings)
  }

  /** Evaluate and express in `unit` (dimension-checked). */
  in<E>(unit: Unit<E> & Same<D, E>, bindings: Bindings = {}): number {
    assertSameDim(this.dim, unit.dim, `in(${unit.name})`)
    return this.eval(bindings) / unit.scale
  }
}

const lift = (o: number | Expr<any>): Expr<any> => (typeof o === 'number' ? new Expr({ k: 'const', v: o }, {}) : o)

doc({
  name: 'Expr',
  kind: 'class',
  module: 'pricesim',
  summary:
    'A quantity with a dimension: a constant, a symbol, a param, or arithmetic over them. Every amount in a model (rates, sizes, prices, capacities) is one.',
  signature: `class Expr<D> {
  mul(o: Expr | number): Expr;  div(o: Expr | number): Expr
  add(o: Expr<D>): Expr<D>;  sub(o: Expr<D>): Expr<D>
  as(unit: Unit<E>): Expr<E>
  eval(bindings?: Bindings): number
  in(unit: Unit<D>, bindings?: Bindings): number
}`,
  guidance: `
- Build them with \`q\` (constants), \`sym\` (free variables), \`param\` (overridable constants) and \`parseQuantity\` (strings); the engine hands you others (request attributes, rates, gauge levels).
- **Immutable and symbolic:** operations build a new expression tree; nothing is computed until \`eval\`/\`in\`. That is what lets the engine re-evaluate the same model per time step and print closed forms.
- **\`mul\`/\`div\`** combine dimensions (\`GB/s × s\` → \`GB\`); a plain number is a dimensionless factor (\`.mul(3)\`).
- **\`add\`/\`sub\`** need the same dimension: a mismatch is a compile error, and a \`UnitError\` at runtime for values whose types were lost. Different units of one dimension (GB + GiB) are fine; values are stored in base units.
- **\`in(unit, bindings?)\`** evaluates and converts to \`unit\`, which must have the same dimension. **\`eval(bindings?)\`** returns base units (bytes, seconds, USD, …) and is rarely what you want to print.
- **\`as(unit)\`** checks the dimension at runtime and narrows the type; use it on \`Expr<unknown>\` from \`parseQuantity\` or other untyped input. It does not convert anything.
- \`bindings\` give symbols and params values: numbers in base units, or expressions. An unbound \`sym\` throws; an unbound \`param\` uses its default.`,
  examples: [
    `import { q, u } from 'pricesim'

const perSecond = u.req.div(u.s)
const bytesPerReq = q(4, u.KB.div(u.req))
const ingress = q(2000, perSecond).mul(bytesPerReq) // Expr<byte/s>
ingress.in(u.MB.div(u.s)) // 8
const perMonth = ingress.mul(q(1, u.month)) // Expr<byte>
perMonth.in(u.GB) // 21024`,
  ],
  seeAlso: ['q', 'sym', 'param', 'parseQuantity', 'Unit'],
  guide: 'units',
})

/** A constant quantity: `q(8, u.MiB)`. */
export const q = <D>(v: number, unit: Unit<D>): Expr<D> => new Expr({ k: 'const', v: v * unit.scale }, unit.dim)

doc({
  name: 'q',
  kind: 'function',
  module: 'pricesim',
  summary: 'A constant quantity: a number in a unit, e.g. `q(8, u.MiB)` or `q(0.023, u.USD.div(u.GB.mul(u.month)))`.',
  signature: 'q(v: number, unit: Unit<D>): Expr<D>',
  params: [
    { name: 'v', type: 'number', doc: 'The value, in `unit`.' },
    { name: 'unit', type: 'Unit<D>', doc: 'A unit from `u`, a composed one (`u.req.div(u.s)`), or a custom unit.' },
  ],
  returns: 'An `Expr<D>` holding `v × unit.scale` in base units.',
  guidance: `
- The unit is what makes the number mean something; there is no unitless shortcut. For a plain ratio use \`q(0.6, u.one)\`, or pass a number to \`.mul\`/\`.div\`.
- Converting happens once, here: \`q(1, u.GiB)\` and \`q(1073741824, u.byte)\` are the same value.`,
  examples: [
    `import { q, u } from 'pricesim'

const object = q(8, u.MiB)
const cpuPerReq = q(0.2, u.vCPU.mul(u.ms).div(u.req))
const price = q(0.023, u.USD.div(u.GB.mul(u.month)))
object.in(u.KiB) // 8192`,
  ],
  seeAlso: ['u', 'Expr', 'param', 'sym'],
  guide: 'units',
})

/** A free variable (workload input, sweep variable). */
export const sym = <D>(name: string, unit: Unit<D>): Expr<D> => new Expr({ k: 'sym', name }, unit.dim)

doc({
  name: 'sym',
  kind: 'function',
  module: 'pricesim',
  summary: 'A free variable of a given dimension, bound to a value only when the expression is evaluated.',
  signature: 'sym(name: string, unit: Unit<D>): Expr<D>',
  params: [
    { name: 'name', type: 'string', doc: 'The key to bind it by in `eval`/`in` bindings.' },
    {
      name: 'unit',
      type: 'Unit<D>',
      doc: 'Sets the dimension only; the bound value is always in base units, whatever unit is given here.',
    },
  ],
  returns: 'An `Expr<D>` that evaluates to `bindings[name]`.',
  guidance: `
- For expressions you evaluate yourself, e.g. a sizing formula as a function of a rate: \`nodes.in(u.count, { rate: 10_000 })\`.
- Evaluating without a binding throws \`UnitError\` ("unbound symbol").
- Bindings are in base units: for \`sym('size', u.GB)\` bind bytes, not GB.
- For a model constant with a sensible default that a workload or sweep may override, use \`param\`. The engine uses names like \`time\` and \`rate.<request>\` for its own symbols, so avoid them.`,
  examples: [
    `import { ceil, max, q, sym, u } from 'pricesim'

const rate = sym('rate', u.req.div(u.s))
const perNode = q(5000, u.req.div(u.s).div(u.count))
const nodes = max(q(3, u.count), ceil(rate.div(perNode)))
nodes.in(u.count, { rate: 40_000 }) // 8`,
  ],
  seeAlso: ['param', 'Expr', 'q'],
  guide: 'units',
})

/** A named constant with a default, overridable per scenario. */
export const param = <D>(name: string, def: Expr<D>): Expr<D> => new Expr({ k: 'param', name, def: def.node }, def.dim)

doc({
  name: 'param',
  kind: 'function',
  module: 'pricesim',
  summary: 'A named constant with a default, overridable per workload, per sweep point, or in bindings.',
  signature: 'param(name: string, def: Expr<D>): Expr<D>',
  params: [
    {
      name: 'name',
      type: 'string',
      doc: "The override key: a workload's `params: { [name]: … }`, a `pricesim sweep` variable, or an `eval` binding.",
    },
    { name: 'def', type: 'Expr<D>', doc: 'The default, used when nothing overrides it; also sets the dimension.' },
  ],
  returns: 'An `Expr<D>` that evaluates to the override if one is bound, else to `def`.',
  guidance: `
- Use it for assumptions you want to vary without editing the model: load factors, replication, compression ratios, cache hit rates.
- **Overrides are in base units** (a number) or an expression: for \`param('segment', q(1, u.GiB))\`, override with \`1073741824\` or \`q(512, u.MiB)\`. The value is not dimension-checked, so a wrong unit gives a wrong number rather than an error.
- Params are matched by name: two \`param\` calls with the same name share one override (each keeps its own default).`,
  examples: [
    `import { param, q, u } from 'pricesim'

const replication = param('replication', q(3, u.one))
const stored = q(10, u.TB).mul(replication)
stored.in(u.TB) // 30
stored.in(u.TB, { replication: 2 }) // 20`,
  ],
  seeAlso: ['sym', 'q', 'Expr', 'sweep'],
  guide: 'units',
})

export const max = <A, B>(a: Expr<A>, b: Expr<B> & Same<A, B>): Expr<A> =>
  new Expr({ k: 'fn', name: 'max', args: [a.node, b.node] }, assertSameDim(a.dim, b.dim, 'max'))

export const min = <A, B>(a: Expr<A>, b: Expr<B> & Same<A, B>): Expr<A> =>
  new Expr({ k: 'fn', name: 'min', args: [a.node, b.node] }, assertSameDim(a.dim, b.dim, 'min'))

/** ceil/floor apply to the value in base units, so use them on counts and other dimensionless-like quantities. */
export const ceil = <D>(a: Expr<D>): Expr<D> => new Expr({ k: 'fn', name: 'ceil', args: [a.node] }, a.dim)
export const floor = <D>(a: Expr<D>): Expr<D> => new Expr({ k: 'fn', name: 'floor', args: [a.node] }, a.dim)

const fnGuide = 'units'
docs([
  {
    name: 'max',
    kind: 'function',
    module: 'pricesim',
    summary: 'The larger of two expressions of the same dimension, kept symbolic (e.g. a minimum instance count).',
    signature: 'max(a: Expr<D>, b: Expr<D>): Expr<D>',
    guidance: `
- Both arguments must have the same dimension (compile error, and \`UnitError\` at runtime); units may differ (\`max(q(1, u.GB), q(900, u.MiB))\`).
- Evaluated per evaluation, so \`max(q(3, u.count), needed)\` follows the workload.`,
    examples: [
      `import { ceil, max, q, sym, u } from 'pricesim'

const needed = ceil(sym('rate', u.req.div(u.s)).div(q(2000, u.req.div(u.s).div(u.count))))
const nodes = max(q(3, u.count), needed)
nodes.in(u.count, { rate: 1000 }) // 3`,
    ],
    seeAlso: ['min', 'ceil'],
    guide: fnGuide,
  },
  {
    name: 'min',
    kind: 'function',
    module: 'pricesim',
    summary: 'The smaller of two expressions of the same dimension, kept symbolic (e.g. a cap).',
    signature: 'min(a: Expr<D>, b: Expr<D>): Expr<D>',
    guidance: '- Same dimension rules as `max`.',
    seeAlso: ['max'],
    guide: fnGuide,
  },
  {
    name: 'ceil',
    kind: 'function',
    module: 'pricesim',
    summary: 'Round up, on the value in base units: for whole counts (instances, shards, parts).',
    signature: 'ceil(a: Expr<D>): Expr<D>',
    guidance: `
- Rounds the base-unit value, not the value in the unit you think in: \`ceil(q(1.5, u.KB))\` is 1500 bytes, still 1.5 KB. To round to whole GB, divide by \`q(1, u.GB)\` first (dimensionless), round, then multiply back.
- Fine on \`count\`, \`req\` and dimensionless quantities, whose base unit is the thing counted.`,
    examples: [
      `import { ceil, q, u } from 'pricesim'

const parts = ceil(q(100, u.MiB).div(q(16, u.MiB))) // dimensionless
parts.in(u.one) // 7
const gbBilled = ceil(q(1.2, u.TB).div(q(1, u.GB))).mul(q(1, u.GB))`,
    ],
    seeAlso: ['floor', 'max'],
    guide: fnGuide,
  },
  {
    name: 'floor',
    kind: 'function',
    module: 'pricesim',
    summary: 'Round down, on the value in base units (see `ceil` for the pitfall).',
    signature: 'floor(a: Expr<D>): Expr<D>',
    seeAlso: ['ceil'],
    guide: fnGuide,
  },
])

/**
 * Escape hatch for relations that are not closed-form. Inputs are passed to `fn` in base units and the
 * result is interpreted in `unit`. Shows up as a named function in closed-form output.
 */
export const opaque = <I extends Record<string, Expr<any>>, D>(
  name: string,
  spec: { readonly inputs: I; readonly unit: Unit<D> },
  fn: (v: { [K in keyof I]: number }) => number,
): Expr<D> => {
  const inputs = Object.fromEntries(Object.entries(spec.inputs).map(([k, e]) => [k, e.node]))
  const scale = spec.unit.scale
  return new Expr({ k: 'opaque', name, inputs, fn: (v) => fn(v as { [K in keyof I]: number }) * scale }, spec.unit.dim)
}

doc({
  name: 'opaque',
  kind: 'function',
  module: 'pricesim',
  summary:
    'Escape hatch: an expression computed by your own function, for relations with no closed form (lookup tables, queueing models).',
  signature:
    'opaque(name: string, spec: { inputs: Record<string, Expr>; unit: Unit<D> }, fn: (v: Record<string, number>) => number): Expr<D>',
  params: [
    { name: 'name', type: 'string', doc: 'Shown as a named function in closed-form output.' },
    {
      name: 'spec.inputs',
      type: 'Record<string, Expr>',
      doc: 'The expressions `fn` depends on; each is evaluated and passed to `fn` under its key.',
    },
    { name: 'spec.unit', type: 'Unit<D>', doc: 'The unit `fn` returns its result in; sets the dimension.' },
    {
      name: 'fn',
      type: '(v) => number',
      doc: 'Receives every input as a number **in base units** (bytes, seconds, req/s, …) and returns a number in `spec.unit`.',
    },
  ],
  returns: 'An `Expr<D>`.',
  guidance: `
- Inputs arrive in base units whatever units they were written in: a \`q(5, u.ms)\` input arrives as 0.005. Convert inside \`fn\` if your formula wants other units.
- The result is read in \`spec.unit\` (return 5 with \`unit: u.ms\` for 5 ms).
- \`fn\` should be pure: it runs on every evaluation of the expression, which can be many times per scenario.
- Closed forms can't see inside it; prefer ordinary \`Expr\` arithmetic and \`max\`/\`min\`/\`ceil\` when they are enough.`,
  examples: [
    `import { opaque, q, sym, u } from 'pricesim'

const rate = sym('rate', u.req.div(u.s))
// p99 latency from a lookup: 2 ms up to 1000 req/s, then 5 ms
const p99 = opaque('p99', { inputs: { rate }, unit: u.ms }, ({ rate }) => (rate <= 1000 ? 2 : 5))
p99.add(q(1, u.ms)).in(u.ms, { rate: 5000 }) // 6`,
  ],
  seeAlso: ['Expr', 'max'],
  guide: 'units',
})

/** Untyped boundary: parse '5000 req/s' into an Expr of unknown dimension; narrow with `.as(unit)`. */
export const parseQuantity = (s: string): Expr<unknown> => {
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(.*?)\s*$/i.exec(s)
  if (!m) throw new UnitError(`cannot parse quantity '${s}'`)
  const unitV = m[2] ? parseUnit(m[2]) : u.one
  return q(Number(m[1]), unitV as Unit<unknown>)
}

doc({
  name: 'parseQuantity',
  kind: 'function',
  module: 'pricesim',
  summary:
    "Parse a quantity string such as '5000 req/s' or '8 MiB' at an untyped boundary; narrow it with `.as(unit)`.",
  signature: 'parseQuantity(s: string): Expr<unknown>',
  params: [
    {
      name: 's',
      type: 'string',
      doc: 'A number (plain or exponent notation, no thousands separators) followed by a unit string as `parseUnit` reads it. No unit means dimensionless.',
    },
  ],
  returns: 'An `Expr<unknown>`. Call `.as(unit)` to check its dimension and get a typed `Expr`.',
  guidance: `
- For CLI arguments, JSON and generated data. In code, write \`q(5000, u.req.div(u.s))\`.
- \`.as(unit)\` checks the dimension only, and accepts any unit of it: \`parseQuantity('5 GB').as(u.byte)\` is fine and holds 5e9 bytes. A wrong dimension throws \`UnitError\`.
- Unknown units throw \`UnitError\`; custom units must be created with \`baseUnit\`/\`defineUnit\` before parsing.`,
  examples: [
    `import { parseQuantity, u } from 'pricesim'

const rate = parseQuantity('5000 req/s').as(u.req.div(u.s))
rate.in(u.req.div(u.minute)) // 300000`,
  ],
  seeAlso: ['parseUnit', 'q', 'Expr'],
  guide: 'units',
})

const evalNode = (n: Node, b: Bindings): number => {
  switch (n.k) {
    case 'const':
      return n.v
    case 'sym':
    case 'param': {
      const v = b[n.name]
      if (v === undefined) {
        if (n.k === 'param') return evalNode(n.def, b)
        throw new UnitError(`unbound symbol '${n.name}'`)
      }
      return typeof v === 'number' ? v : v.eval(b)
    }
    case 'bin': {
      const x = evalNode(n.a, b)
      const y = evalNode(n.b, b)
      return n.op === '+' ? x + y : n.op === '-' ? x - y : n.op === '*' ? x * y : x / y
    }
    case 'fn': {
      const args = n.args.map((a) => evalNode(a, b))
      if (n.name === 'max') return Math.max(...args)
      if (n.name === 'min') return Math.min(...args)
      if (n.name === 'ceil') return Math.ceil(args[0]!)
      return Math.floor(args[0]!)
    }
    case 'opaque':
      return n.fn(Object.fromEntries(Object.entries(n.inputs).map(([k, v]) => [k, evalNode(v, b)])))
  }
}

/** Whether an expression references the symbol or param `name`. */
export const refersTo = (n: Node, name: string): boolean => {
  switch (n.k) {
    case 'const':
      return false
    case 'sym':
      return n.name === name
    case 'param':
      return n.name === name || refersTo(n.def, name)
    case 'bin':
      return refersTo(n.a, name) || refersTo(n.b, name)
    case 'fn':
      return n.args.some((a) => refersTo(a, name))
    case 'opaque':
      return Object.values(n.inputs).some((a) => refersTo(a, name))
  }
}

docs([
  {
    name: 'refersTo',
    kind: 'function',
    module: 'pricesim',
    summary: 'Whether an expression tree references the symbol or param `name`.',
    internal: true,
  },
  {
    name: 'Bindings',
    kind: 'type',
    module: 'pricesim',
    summary: 'Values for symbols and params, by name: numbers in base units, or expressions.',
    seeAlso: ['sym', 'param'],
    guide: 'units',
  },
  {
    name: 'Node',
    kind: 'type',
    module: 'pricesim',
    summary: 'The expression AST: const (base units), sym, param, bin (+ - * /), fn (max/min/ceil/floor), opaque.',
    internal: true,
  },
])
