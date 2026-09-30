// Type-level dimensional analysis: a dimension is a record of exponents over the base dimensions.
import type { AddTable, NegTable } from './exp-table.js'

export type Base = 'USD' | 's' | 'byte' | 'req' | 'op' | 'millicore' | 'count' | 'stream'
export type Exp = -4 | -3 | -2 | -1 | 0 | 1 | 2 | 3 | 4
export type Dim = { readonly [K in Base]?: Exp }

type Get<D, K extends Base> = K extends keyof D ? (D[K] extends Exp ? D[K] : 0) : 0
type AddExp<A extends Exp, B extends Exp> = AddTable[`${A}`][`${B}`]
// drop zero exponents so {USD:1, s:0} and {USD:1} are the same type
type Normalize<T> = { [K in keyof T as T[K] extends 0 ? never : K]: T[K] }
// force TS to display the evaluated object instead of the alias
type Simplify<T> = { [K in keyof T]: T[K] } & {}
type Neg<B> = { [K in keyof B]: B[K] extends Exp ? NegTable[`${B[K]}`] : B[K] }

export type Mul<A, B> = Simplify<Normalize<{ [K in Base]: AddExp<Get<A, K>, Get<B, K>> }>>
export type Div<A, B> = Mul<A, Neg<B>>

// exact equality check that yields a readable error property on mismatch
type Mismatch<Expected, Got> = { readonly 'unit mismatch': { expected: Expected; got: Got } }
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? unknown : Mismatch<A, B>) : Mismatch<A, B>
