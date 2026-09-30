// Dimensions: tracked in types (compile time) and as exponent records (runtime, the source of truth).
// See DESIGN.md §3.1 and spike/units-types/README.md for why the types look the way they do.
import { docs } from '../docs/registry.ts'
import type { AddTable, Exp, NegTable } from './dim-tables.gen.ts'

export type { Exp }
/** The built-in base dimensions. Others can be created at runtime with `baseUnit(name)` (units.ts). */
export const BASE_DIMS = ['USD', 's', 'byte', 'req', 'op', 'millicore', 'count'] as const
export type Base = (typeof BASE_DIMS)[number]

/**
 * A dimension: exponent per base dimension; absent keys are 0. Keys are the built-in base dimensions or any
 * custom ones (e.g. 'stream', 'partition'), which the type system tracks by name like the built-ins.
 */
export type Dim = { readonly [K in string]?: Exp }
export type Dimensionless = {}

// ---------- type level ----------
type Get<D, K extends PropertyKey> = K extends keyof D ? (D[K] extends Exp ? D[K] : 0) : 0
type AddExp<A extends Exp, B extends Exp> = AddTable[`${A}`][`${B}`]
/** drop zero exponents so {USD:1, s:0} and {USD:1} are the same type */
type Normalize<T> = { [K in keyof T as T[K] extends 0 ? never : K]: T[K] }
/** force the checker to display the evaluated object, e.g. { s: -1; byte: 1 } */
type Simplify<T> = { [K in keyof T]: T[K] } & {}
type Neg<B> = { [K in keyof B]: B[K] extends Exp ? NegTable[`${B[K]}`] : B[K] }
/** every dimension name appearing in either operand (built-in or custom) */
type Keys<A, B> = (keyof A | keyof B) & string

export type Mul<A, B> = Simplify<Normalize<{ [K in Keys<A, B>]: AddExp<Get<A, K>, Get<B, K>> }>>
export type Div<A, B> = Mul<A, Neg<B>>

type Mismatch<Expected, Got> = { readonly 'unit mismatch': { expected: Expected; got: Got } }
/** exact dimension equality; on mismatch yields a type whose error names expected vs got */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? unknown : Mismatch<A, B>) : Mismatch<A, B>

// ---------- runtime ----------
/** exponents by dimension name (built-in or custom); absent = 0 */
export type RDim = Readonly<Record<string, number>>

export class UnitError extends Error {
  override name = 'UnitError'
}

export const combine = (a: RDim, b: RDim, sign: 1 | -1): RDim => {
  const out: Record<string, number> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const n = (out[k] ?? 0) + sign * v
    if (n === 0) delete out[k]
    else out[k] = n
  }
  return out
}

export const sameDim = (a: RDim, b: RDim): boolean => {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false
  return true
}

/** built-in dimensions first (in their canonical order), then custom ones alphabetically */
export const showDim = (d: RDim): string => {
  const order = (k: string) => {
    const i = (BASE_DIMS as readonly string[]).indexOf(k)
    return i < 0 ? BASE_DIMS.length : i
  }
  const keys = Object.keys(d)
    .filter((k) => d[k])
    .sort((x, y) => order(x) - order(y) || x.localeCompare(y))
  const parts = keys.map((k) => (d[k] === 1 ? k : `${k}^${d[k]}`))
  return parts.length ? parts.join('*') : '1'
}

export const assertSameDim = (a: RDim, b: RDim, op: string): RDim => {
  if (!sameDim(a, b)) throw new UnitError(`unit mismatch in ${op}: ${showDim(a)} vs ${showDim(b)}`)
  return a
}

docs([
  {
    name: 'BASE_DIMS',
    kind: 'const',
    module: 'pricesim',
    summary: "The built-in base dimensions: 'USD', 's', 'byte', 'req', 'op', 'millicore', 'count'.",
    internal: true,
  },
  {
    name: 'UnitError',
    kind: 'class',
    module: 'pricesim',
    summary: 'The error thrown on a dimension mismatch, an unknown or invalid unit, or an unbound symbol.',
    guidance: `
- Thrown by \`add\`/\`sub\`/\`max\`/\`min\`, \`.as(unit)\` and \`.in(unit)\` when dimensions differ; the message names both, e.g. \`unit mismatch in +: byte vs s^-1*byte\`.
- Mismatches in typed code are usually compile errors first; the runtime check covers values from untyped boundaries (\`parseQuantity\`, JSON, the CLI).
- Also thrown by \`parseUnit\`/\`parseQuantity\` for unknown units, by \`baseUnit\`/\`defineUnit\` for bad names, and by \`eval\` for an unbound symbol.`,
    seeAlso: ['Expr', 'parseQuantity'],
    guide: 'units',
  },
  {
    name: 'combine',
    kind: 'function',
    module: 'pricesim',
    summary: 'Add (sign 1) or subtract (sign -1) two runtime exponent records.',
    internal: true,
  },
  {
    name: 'sameDim',
    kind: 'function',
    module: 'pricesim',
    summary: 'Whether two runtime exponent records are the same dimension.',
    internal: true,
  },
  {
    name: 'showDim',
    kind: 'function',
    module: 'pricesim',
    summary: "Print a runtime dimension, e.g. 's^-1*byte'; '1' for dimensionless.",
    internal: true,
  },
  {
    name: 'assertSameDim',
    kind: 'function',
    module: 'pricesim',
    summary: 'Throw a UnitError naming `op` unless two runtime dimensions are equal; returns the first.',
    internal: true,
  },
  {
    name: 'Same',
    kind: 'type',
    module: 'pricesim',
    summary:
      "Compile-time dimension equality: `unknown` when A and B match, otherwise a type whose error names 'unit mismatch' with expected and got.",
    internal: true,
  },
  {
    name: 'Mul',
    kind: 'type',
    module: 'pricesim',
    summary: 'The type-level product of two dimensions (exponents added; `Div` subtracts them).',
    internal: true,
  },
  {
    name: 'RDim',
    kind: 'type',
    module: 'pricesim',
    summary: 'A runtime dimension: exponent by dimension name, absent meaning 0. `Expr.dim` and `Unit.dim` hold one.',
    internal: true,
  },
])
