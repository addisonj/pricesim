// Baseline: same API surface, no dimension tracking in types.
export type Base = 'USD' | 's' | 'byte' | 'req' | 'op' | 'millicore' | 'count' | 'stream'
export type Dim = { readonly [K in Base]?: number }
export type Mul<A, B> = any
export type Div<A, B> = any
export type Same<A, B> = unknown
