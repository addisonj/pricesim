// Inputs a scenario exposes to the UI, discovered from its workload(s), and how overrides are applied.
//
// Override keys are the sweep variables of the library (`withOverrides`, DESIGN.md §8), in base units:
//   rate.<request>    mean request rate (req/s); the request's series is scaled to that mean
//   <request>.<attr>  request attribute
//   gauge.<name>      root gauge level
//   <param>           param override
// Multi-tenant scenarios prefix per-tenant keys with `<tenant>::`, and `*::rate.<request>` scales that
// request's rate for every tenant (a factor, not a rate). Params apply to every tenant.
import {
  expand,
  isDist,
  meanRateBindings,
  refersTo,
  seriesMean,
  showDim,
  tenantsOf,
  withOverrides,
  withWorkload,
  Expr,
  type Bindings,
  type Node,
  type Scenario,
  type Tenant,
  type Workload,
} from 'pricesim'

export type Overrides = Readonly<Record<string, number>>

export type InputGroup = 'rates' | 'attrs' | 'gauges' | 'params'

export interface InputSpec {
  /** override key (see the header) */
  readonly key: string
  /** the key without its tenant prefix */
  readonly name: string
  readonly group: InputGroup
  /** tenant id for per-tenant inputs; '*' for all-tenant scale factors */
  readonly tenant?: string
  /** base unit of the value, e.g. 'req/s', 'byte', '×' */
  readonly unit: string
  /** the scenario's own value, in base units */
  readonly base: number
  /** slider bounds */
  readonly min: number
  readonly max: number
  readonly log: boolean
  readonly note?: string
}

export const ALL_TENANTS = '*'
const SEP = '::'

const unitOf = (dim: Expr<any>['dim']): string => {
  const d = showDim(dim)
  if (d === 'req*s^-1') return 'req/s'
  if (d === 'byte*s^-1') return 'byte/s'
  return d === '1' ? '' : d
}

/** Slider bounds around a scenario value: log over four decades for positive values, else linear. */
const bounds = (base: number, group: InputGroup): Pick<InputSpec, 'min' | 'max' | 'log'> => {
  if (group === 'params') return base > 0 ? { min: 0, max: base * 3, log: false } : { min: 0, max: 1, log: false }
  if (base > 0) return { min: base / 100, max: base * 100, log: true }
  return group === 'rates' ? { min: 0.001, max: 1000, log: true } : { min: 0, max: 1, log: false }
}

const safeEval = (e: Expr<any>, b: Bindings): number | undefined => {
  try {
    const v = e.eval(b)
    return Number.isFinite(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** Params referenced anywhere in the expansion of a workload, with their defaults. */
const paramsIn = (s: Scenario, w: Workload): Map<string, Expr<any>> => {
  const found = new Map<string, Expr<any>>()
  const walk = (n: Node) => {
    switch (n.k) {
      case 'param':
        if (!found.has(n.name)) found.set(n.name, new Expr<any>(n.def, {}))
        return walk(n.def)
      case 'bin':
        walk(n.a)
        return walk(n.b)
      case 'fn':
        return n.args.forEach(walk)
      case 'opaque':
        return Object.values(n.inputs).forEach(walk)
    }
  }
  try {
    const x = expand(withWorkload(s, w), w)
    for (const c of [...x.requests.flatMap((r) => r.contribs), ...x.levels]) {
      walk(c.amount.node)
      if (c.mult) walk(c.mult.node)
    }
  } catch {
    // an expansion error surfaces in evaluate(); inputs just omit params
  }
  return found
}

const workloadInputs = (w: Workload, tenant?: string): InputSpec[] => {
  const prefix = tenant ? `${tenant}${SEP}` : ''
  const numericParams = Object.fromEntries(Object.entries(w.params).filter(([, v]) => typeof v === 'number'))
  const b: Bindings = { ...meanRateBindings(w), ...numericParams, time: w.periodSeconds / 2 }
  const out: InputSpec[] = []
  const add = (name: string, group: InputGroup, unit: string, base: number, note?: string) =>
    out.push({
      key: prefix + name,
      name,
      group,
      ...(tenant ? { tenant } : {}),
      unit,
      base,
      ...bounds(base, group),
      ...(note ? { note } : {}),
    })
  for (const [req, load] of Object.entries(w.requests)) {
    if (!load) continue
    add(`rate.${req}`, 'rates', 'req/s', seriesMean(load.rate, w.periodSeconds, w.stepSeconds), load.rate.describe)
    for (const [attr, v] of Object.entries(load.attrs)) {
      if (isDist(v)) add(`${req}.${attr}`, 'attrs', unitOf(v.dim), v.mean, `${v.describe}: overriding pins its mean`)
      else {
        const base = safeEval(v, b)
        if (base !== undefined) add(`${req}.${attr}`, 'attrs', unitOf(v.dim), base)
      }
    }
  }
  const requests = Object.keys(w.requests)
  for (const [g, e] of Object.entries(w.gauges)) {
    const base = safeEval(e, b)
    if (base === undefined) continue
    const derived = requests.some((r) => refersTo(e.node, `rate.${r}`))
    const timed = refersTo(e.node, 'time')
    const note = derived
      ? 'derived from request rates; overriding pins it'
      : timed
        ? 'varies over the period (mid-period value); overriding pins it'
        : undefined
    add(`gauge.${g}`, 'gauges', unitOf(e.dim), base, note)
  }
  return out
}

/** Every input a scenario exposes, in display order. */
export const discoverInputs = (s: Scenario): InputSpec[] => {
  const ws = tenantsOf(s)
  const inputs: InputSpec[] = []
  if (s.tenants) {
    const requests = [...new Set(ws.flatMap((t) => Object.keys(t.workload.requests)))]
    for (const req of requests)
      inputs.push({
        key: `${ALL_TENANTS}${SEP}rate.${req}`,
        name: `rate.${req}`,
        group: 'rates',
        tenant: ALL_TENANTS,
        unit: '×',
        base: 1,
        min: 0.01,
        max: 100,
        log: true,
        note: `scales every tenant's ${req} rate`,
      })
    for (const t of ws) inputs.push(...workloadInputs(t.workload, t.id))
  } else inputs.push(...workloadInputs(s.workload))

  // params: global, with the (first) workload's value or the model default
  const first = ws[0]!.workload
  const params = paramsIn(s, first)
  for (const name of Object.keys(first.params))
    if (!params.has(name)) params.set(name, new Expr<any>({ k: 'const', v: 0 }, {}))
  const b: Bindings = { ...meanRateBindings(first), ...first.params }
  for (const [name, def] of params) {
    const own = first.params[name]
    const base = typeof own === 'number' ? own : safeEval(own ?? def, b)
    if (base === undefined) continue
    inputs.push({ key: name, name, group: 'params', unit: unitOf(def.dim), base, ...bounds(base, 'params') })
  }
  return inputs
}

const splitKey = (key: string): { tenant?: string; name: string } => {
  const i = key.indexOf(SEP)
  return i < 0 ? { name: key } : { tenant: key.slice(0, i), name: key.slice(i + SEP.length) }
}

const isParam = (name: string) => !name.includes('.')

/** whether a workload has the rate, attribute or gauge a key names (params always apply) */
const knownIn = (w: Workload, name: string): boolean => {
  const dot = name.indexOf('.')
  if (dot < 0) return true
  const head = name.slice(0, dot)
  const rest = name.slice(dot + 1)
  if (head === 'rate') return !!w.requests[rest]
  if (head === 'gauge') return !!w.gauges[rest]
  const load = w.requests[head]
  return !!load && rest in load.attrs
}

/** withOverrides on one workload, skipping keys it doesn't have (e.g. a request only some tenants make) */
const overrideWorkload = (s: Scenario, w: Workload, point: Overrides): Workload => {
  const known = Object.fromEntries(Object.entries(point).filter(([name]) => knownIn(w, name)))
  return Object.keys(known).length ? withOverrides(withWorkload(s, w), known).workload! : w
}

/**
 * A copy of the scenario with the overrides applied (library `withOverrides` per workload). Keys a workload
 * doesn't have are ignored.
 */
export const applyOverrides = (s: Scenario, overrides: Overrides): Scenario => {
  const entries = Object.entries(overrides)
  if (!entries.length) return s
  if (!s.tenants) return { ...s, workload: overrideWorkload(s, s.workload, overrides) }

  const params: Record<string, number> = {}
  const scale: Record<string, number> = {}
  const perTenant = new Map<string, Record<string, number>>()
  for (const [key, v] of entries) {
    const { tenant, name } = splitKey(key)
    if (tenant === ALL_TENANTS) scale[name] = v
    else if (tenant !== undefined) perTenant.set(tenant, { ...perTenant.get(tenant), [name]: v })
    else if (isParam(name)) params[name] = v
  }
  const tenants = s.tenants.map((t): Tenant => {
    const w = t.workload
    const point: Record<string, number> = { ...params, ...perTenant.get(t.id) }
    for (const [name, f] of Object.entries(scale)) {
      const load = w.requests[name.slice('rate.'.length)]
      if (load) point[name] = (point[name] ?? seriesMean(load.rate, w.periodSeconds, w.stepSeconds)) * f
    }
    const workload = overrideWorkload(s, w, point)
    return workload === w ? t : { ...t, workload }
  })
  return { ...s, tenants }
}
