// Spike core: units, expressions, and the model-layer API (offering / service / request / pool / gauge).
// Types come from '#dim' (typed or untyped); the runtime dimension check is always on.
import type { Base, Mul, Div, Same } from '#dim'

type RDim = Partial<Record<Base, number>>
const rcombine = (a: RDim, b: RDim, sign: 1 | -1): RDim => {
  const out: RDim = { ...a }
  for (const [k, v] of Object.entries(b) as [Base, number][]) {
    const n = (out[k] ?? 0) + sign * v
    if (n === 0) delete out[k]
    else out[k] = n
  }
  return out
}
const rsame = (a: RDim, b: RDim) => Object.keys(rcombine(a, b, -1)).length === 0
const rshow = (d: RDim) => JSON.stringify(d)

export class UnitError extends Error {}

// ---------- units ----------
export class Unit<D> {
  declare readonly __dim: (d: D) => D // phantom, makes D invariant
  constructor(readonly name: string, readonly scale: number, readonly dim: RDim) {}
  mul<E>(o: Unit<E>): Unit<Mul<D, E>> {
    return new Unit(`${this.name}*${o.name}`, this.scale * o.scale, rcombine(this.dim, o.dim, 1))
  }
  div<E>(o: Unit<E>): Unit<Div<D, E>> {
    return new Unit(`${this.name}/${o.name}`, this.scale / o.scale, rcombine(this.dim, o.dim, -1))
  }
}
const unit = <D>(name: string, dim: RDim, scale = 1) => new Unit<D>(name, scale, dim)

export const u = {
  USD: unit<{ USD: 1 }>('USD', { USD: 1 }),
  s: unit<{ s: 1 }>('s', { s: 1 }),
  ms: unit<{ s: 1 }>('ms', { s: 1 }, 1e-3),
  hour: unit<{ s: 1 }>('hour', { s: 1 }, 3600),
  day: unit<{ s: 1 }>('day', { s: 1 }, 86400),
  month: unit<{ s: 1 }>('month', { s: 1 }, 730 * 3600),
  byte: unit<{ byte: 1 }>('byte', { byte: 1 }),
  KB: unit<{ byte: 1 }>('KB', { byte: 1 }, 1e3),
  MB: unit<{ byte: 1 }>('MB', { byte: 1 }, 1e6),
  GB: unit<{ byte: 1 }>('GB', { byte: 1 }, 1e9),
  KiB: unit<{ byte: 1 }>('KiB', { byte: 1 }, 1024),
  MiB: unit<{ byte: 1 }>('MiB', { byte: 1 }, 1024 ** 2),
  GiB: unit<{ byte: 1 }>('GiB', { byte: 1 }, 1024 ** 3),
  TiB: unit<{ byte: 1 }>('TiB', { byte: 1 }, 1024 ** 4),
  Gbps: unit<{ byte: 1; s: -1 }>('Gbps', { byte: 1, s: -1 }, 1.25e8),
  req: unit<{ req: 1 }>('req', { req: 1 }),
  op: unit<{ op: 1 }>('op', { op: 1 }),
  millicore: unit<{ millicore: 1 }>('millicore', { millicore: 1 }),
  vCPU: unit<{ millicore: 1 }>('vCPU', { millicore: 1 }, 1000),
  count: unit<{ count: 1 }>('count', { count: 1 }),
  stream: unit<{ stream: 1 }>('stream', { stream: 1 }),
  one: unit<{}>('1', {}),
}

// ---------- expressions ----------
type Node =
  | { k: 'const'; v: number }
  | { k: 'sym'; name: string }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Node; b: Node }
  | { k: 'fn'; name: 'max' | 'min' | 'ceil'; args: Node[] }
  | { k: 'opaque'; name: string; inputs: Record<string, Node> }

export class Expr<D> {
  declare readonly __dim: (d: D) => D // phantom, makes D invariant
  constructor(readonly node: Node, readonly dim: RDim) {}
  mul<E>(o: Expr<E>): Expr<Mul<D, E>> {
    return new Expr({ k: 'bin', op: '*', a: this.node, b: o.node }, rcombine(this.dim, o.dim, 1))
  }
  div<E>(o: Expr<E>): Expr<Div<D, E>> {
    return new Expr({ k: 'bin', op: '/', a: this.node, b: o.node }, rcombine(this.dim, o.dim, -1))
  }
  add<E>(o: Expr<E> & Same<D, E>): Expr<D> {
    return new Expr({ k: 'bin', op: '+', a: this.node, b: o.node }, checkSame(this.dim, o.dim, '+'))
  }
  sub<E>(o: Expr<E> & Same<D, E>): Expr<D> {
    return new Expr({ k: 'bin', op: '-', a: this.node, b: o.node }, checkSame(this.dim, o.dim, '-'))
  }
  /** checked boundary: runtime dimension check, narrows the static type */
  as<E>(target: Unit<E>): Expr<E> {
    checkSame(this.dim, target.dim, 'as')
    return this as unknown as Expr<E>
  }
}
const checkSame = (a: RDim, b: RDim, op: string) => {
  if (!rsame(a, b)) throw new UnitError(`unit mismatch in ${op}: ${rshow(a)} vs ${rshow(b)}`)
  return a
}

export const q = <D>(v: number, unit: Unit<D>): Expr<D> => new Expr({ k: 'const', v: v * unit.scale }, unit.dim)
export const sym = <D>(name: string, unit: Unit<D>): Expr<D> => new Expr({ k: 'sym', name }, unit.dim)
export const param = <D>(name: string, def: Expr<D>): Expr<D> => new Expr({ k: 'sym', name }, def.dim)
export const max = <A, B>(a: Expr<A>, b: Expr<B> & Same<A, B>): Expr<A> =>
  new Expr({ k: 'fn', name: 'max', args: [a.node, b.node] }, checkSame(a.dim, b.dim, 'max'))
export const min = <A, B>(a: Expr<A>, b: Expr<B> & Same<A, B>): Expr<A> =>
  new Expr({ k: 'fn', name: 'min', args: [a.node, b.node] }, checkSame(a.dim, b.dim, 'min'))
export const ceil = <D>(a: Expr<D>): Expr<D> => new Expr({ k: 'fn', name: 'ceil', args: [a.node] }, a.dim)
export const opaque = <I extends Record<string, Expr<any>>, D>(
  name: string,
  spec: { inputs: I; unit: Unit<D> },
  _fn: (v: { [K in keyof I]: number }) => number,
): Expr<D> =>
  new Expr({ k: 'opaque', name, inputs: Object.fromEntries(Object.entries(spec.inputs).map(([k, e]) => [k, e.node])) }, spec.unit.dim)
/** untyped boundary (CLI, JSON, sweeps) */
export const parseQuantity = (s: string): Expr<unknown> => {
  const [num, unitStr = '1'] = s.trim().split(/\s+/)
  const [numer, denom] = unitStr.split('/')
  const lookup = (name: string) => (u as Record<string, Unit<any>>)[name === '1' ? 'one' : name] ?? (() => { throw new UnitError(`unknown unit ${name}`) })()
  const fold = (part: string | undefined) => (part ?? '1').split('*').map(lookup).reduce((a, b) => a.mul(b))
  const unitV = denom ? fold(numer).div(fold(denom)) : fold(numer)
  return new Expr({ k: 'const', v: Number(num) * unitV.scale }, unitV.dim)
}

// ---------- catalog ----------
export type CpuSeconds = { millicore: 1; s: 1 }
export interface InstanceSpec {
  cpu: Expr<{ millicore: 1 }>
  memory: Expr<{ byte: 1 }>
  network: Expr<{ byte: 1; s: -1 }>
  ebsBandwidth: Expr<{ byte: 1; s: -1 }>
  ebsIops: Expr<{ op: 1; s: -1 }>
  price: Expr<{ USD: 1; s: -1 }>
}
export const instance = (id: string, spec: InstanceSpec) => ({ id, ...spec })
export type Instance = ReturnType<typeof instance>

export interface BillingDimension<D> { id: string; usageUnit: Unit<D> }
export const dimension = <D>(id: string, usageUnit: Unit<D>): BillingDimension<D> => ({ id, usageUnit })
export interface Bill { dim: string; usage: Expr<any> }
export const bill = <D, E>(d: BillingDimension<D>, usage: Expr<E> & Same<D, E>): Bill => ({ dim: d.id, usage })

// ---------- model layer ----------
export type AttrUnits = Record<string, Unit<any>>
export type AttrExprs<A extends AttrUnits> = { [K in keyof A]: A[K] extends Unit<infer D> ? Expr<D> : never }

export interface Call { target: string; request: string; attrs: Record<string, Expr<any>>; times(n: Expr<{}>): Call }
export interface PoolUse { pool: string; resource: string; amount: Expr<any> }
export interface Edge { bytes: Expr<{ byte: 1 }>; pattern: 'uniformClients' | 'replicate' | 'sameAz'; rf?: number }
export const edge = (e: Edge) => e
export interface RequestBody { use?: PoolUse[]; calls?: Call[]; net?: Edge[]; bill?: Bill[] }

export interface RequestDef<A extends AttrUnits> { attrs: A; body: (r: AttrExprs<A>) => RequestBody }
export const request = <A extends AttrUnits>(attrs: A, body: (r: AttrExprs<A>) => RequestBody): RequestDef<A> => ({ attrs, body })

export interface GaugeDef<D> { unit: Unit<D> }
export const gauge = <D>(unit: Unit<D>): GaugeDef<D> => ({ unit })
export interface GaugeMapping { gauge: string; value: Expr<any> }

export class Pool {
  constructor(readonly name: string, readonly spec: { instance: Instance; min: number; azs: number; loadFactor: Expr<{}> }) {}
  // style A: exact-match via Same<> (readable 'unit mismatch' error)
  cpu<E>(perRequest: Expr<E> & Same<E, CpuSeconds>): PoolUse {
    return { pool: this.name, resource: 'cpu', amount: perRequest }
  }
  // style B: plain invariant parameter type (TS's default assignability error)
  network(perRequest: Expr<{ byte: 1 }>): PoolUse {
    return { pool: this.name, resource: 'network', amount: perRequest }
  }
  memory<E>(level: Expr<E> & Same<E, { byte: 1 }>): PoolUse {
    return { pool: this.name, resource: 'memory', amount: level }
  }
  /** required nodes on the cpu dimension, as a typed expression */
  cpuNodes(cpuDemand: Expr<{ millicore: 1 }>): Expr<{ count: 1 }> {
    const perNode = this.spec.instance.cpu.div(q(1, u.count)).mul(this.spec.loadFactor)
    return max(q(this.spec.min, u.count), ceil(cpuDemand.div(perNode)))
  }
}
export const pool = (name: string, spec: Pool['spec']) => new Pool(name, spec)

// A graph node (offering or service) as seen by its callers
export type Callable<R extends Record<string, RequestDef<any>>, G extends Record<string, GaugeDef<any>>> = {
  name: string
  requests: { [K in keyof R]: (attrs: AttrExprs<R[K]['attrs']>) => Call }
  gauges: { [K in keyof G]: (value: G[K] extends GaugeDef<infer D> ? Expr<D> : never) => GaugeMapping }
}
// callers only need the shape; `any` here must not flow through the invariant Expr<D>
type AnyCallable = { name: string; requests: Record<string, (attrs: any) => Call>; gauges: Record<string, (value: any) => GaugeMapping> }

export interface Ctx<Deps, Pools> { deps: Deps; pools: Pools }

const makeCallable = <R extends Record<string, RequestDef<any>>, G extends Record<string, GaugeDef<any>>>(
  name: string, reqs: R, gauges: G,
): Callable<R, G> => {
  const mkCall = (request: string, attrs: Record<string, Expr<any>>): Call => ({
    target: name, request, attrs, times: (n) => ({ ...mkCall(request, attrs), attrs: { ...attrs, __times: n } }),
  })
  return {
    name,
    requests: Object.fromEntries(Object.keys(reqs).map((k) => [k, (a: Record<string, Expr<any>>) => mkCall(k, a)])) as any,
    gauges: Object.fromEntries(Object.keys(gauges).map((k) => [k, (value: Expr<any>) => ({ gauge: `${name}.${k}`, value })])) as any,
  }
}

export const offering = <R extends Record<string, RequestDef<any>>, G extends Record<string, GaugeDef<any>>>(
  name: string, def: { gauges: G; requests: R },
) => makeCallable(name, def.requests, def.gauges)

export const service = <
  Deps extends Record<string, AnyCallable>,
  Pools extends Record<string, Pool>,
  G extends Record<string, GaugeDef<any>>,
  R extends Record<string, RequestDef<any>>,
>(
  name: string,
  def: {
    deps: Deps
    pools: Pools
    gauges: G
    requests: (ctx: Ctx<Deps, Pools>) => R
    gaugeUse?: (g: { [K in keyof G]: G[K] extends GaugeDef<infer D> ? Expr<D> : never }, ctx: Ctx<Deps, Pools>) => PoolUse[]
    gaugeMap?: (g: { [K in keyof G]: G[K] extends GaugeDef<infer D> ? Expr<D> : never }, ctx: Ctx<Deps, Pools>) => GaugeMapping[]
  },
) => makeCallable(name, def.requests({ deps: def.deps, pools: def.pools }), def.gauges)
