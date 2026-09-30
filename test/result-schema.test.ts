// schema/result.schema.json (PLAN M4.4) describes `pricesim eval --json`. A small validator for the subset of JSON
// Schema 2020-12 the schema uses; it rejects keywords it doesn't know so nothing is silently ignored.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import guide, { shared, sharedPriced } from '../examples/guide-example.ts'
import { evaluate, roundResult } from '../src/index.ts'

type Schema = { readonly [k: string]: any }

const ANNOTATIONS = new Set(['$schema', 'title', 'description', '$comment', '$defs'])
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  '$ref',
  'minimum',
  'exclusiveMinimum',
])

const typeOk = (t: string, v: unknown): boolean => {
  switch (t) {
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v)
    case 'array':
      return Array.isArray(v)
    case 'string':
      return typeof v === 'string'
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'integer':
      return Number.isInteger(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'null':
      return v === null
    default:
      throw new Error(`unsupported type '${t}'`)
  }
}

/** Errors as `path: message`; empty when `value` is valid. */
const validate = (root: Schema, value: unknown): string[] => {
  const errors: string[] = []
  const resolve = (ref: string): Schema => {
    const m = /^#\/\$defs\/([^/]+)$/.exec(ref)
    if (!m || !root.$defs?.[m[1]!]) throw new Error(`unsupported $ref '${ref}'`)
    return root.$defs[m[1]!]
  }
  const check = (s: Schema, v: unknown, path: string): void => {
    for (const k of Object.keys(s)) {
      if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) throw new Error(`unsupported keyword '${k}' at ${path}`)
    }
    if (s.$ref) check(resolve(s.$ref), v, path)
    const types: string[] | undefined = s.type === undefined ? undefined : Array.isArray(s.type) ? s.type : [s.type]
    if (types && !types.some((ty) => typeOk(ty, v)))
      return void errors.push(`${path}: expected ${types.join(' | ')}, got ${JSON.stringify(v)}`)
    if ('const' in s && v !== s.const) errors.push(`${path}: expected ${JSON.stringify(s.const)}`)
    if (s.enum && !s.enum.includes(v)) errors.push(`${path}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`)
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${path}: ${v} < ${s.minimum}`)
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) errors.push(`${path}: ${v} <= min`)
    }
    if (Array.isArray(v) && s.items) v.forEach((x, i) => check(s.items, x, `${path}[${i}]`))
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      for (const r of s.required ?? []) if (!(r in o)) errors.push(`${path}: missing '${r}'`)
      for (const [k, x] of Object.entries(o)) {
        const p = s.properties?.[k]
        if (p) check(p, x, `${path}.${k}`)
        else if (s.additionalProperties === false) errors.push(`${path}: unexpected property '${k}'`)
      }
    }
  }
  check(root, value, '$')
  return errors
}

const schema = JSON.parse(readFileSync(new URL('../schema/result.schema.json', import.meta.url), 'utf8')) as Schema
const golden = JSON.parse(readFileSync(new URL('../examples/orders-platform.expected.json', import.meta.url), 'utf8'))
const asJson = (v: unknown) => JSON.parse(JSON.stringify(v))

describe('result schema', () => {
  it('is draft 2020-12', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
  })

  it('validates the golden `pricesim eval --json` output', () => {
    expect(validate(schema, golden)).toEqual([])
  })

  it('validates a result with fixed charges and instance pools, and a multi-tenant result', () => {
    expect(validate(schema, asJson(roundResult(evaluate(guide))))).toEqual([])
    const multi = asJson(roundResult(evaluate(shared)))
    expect(multi.tenants).toHaveLength(2)
    expect(validate(schema, multi)).toEqual([])
  })

  it('validates a result with revenue (price book, per-customer plans)', () => {
    const priced = asJson(roundResult(evaluate(sharedPriced)))
    expect(priced.revenue.customers).toHaveLength(2)
    expect(validate(schema, priced)).toEqual([])
  })

  it('accepts schemaVersion 1 and rejects other versions', () => {
    expect(validate(schema, { ...golden, schemaVersion: 1 })).toEqual([])
    expect(validate(schema, { ...golden, schemaVersion: 2 })).toEqual(['$.schemaVersion: expected 1'])
  })

  it('rejects malformed results', () => {
    const { total: _t, ...noTotal } = golden
    expect(validate(schema, noTotal)).toEqual(["$: missing 'total'"])
    const badKind = { ...golden, tree: { ...golden.tree, kind: 'widget' } }
    expect(validate(schema, badKind)[0]).toMatch(/^\$\.tree\.kind: "widget" not in/)
    const extra = { ...golden, pools: [{ ...golden.pools[0], color: 'red' }] }
    expect(validate(schema, extra)).toEqual(["$.pools[0]: unexpected property 'color'"])
  })
})
