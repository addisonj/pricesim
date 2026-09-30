// Shared helpers for the CLI commands: loading and type-checking a model file, formatting, output.
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { CostNode, Result } from '../eval/evaluate.ts'
import type { UnitCost } from '../eval/unit-cost.ts'
import type { ClosedForm } from '../eval/closed-form.ts'
import type { Scenario } from '../eval/scenario.ts'

export const fail = (msg: string): never => {
  process.stderr.write(`pricesim: ${msg}\n`)
  process.exit(1)
}

/** Type-check the model with the nearest tsconfig.json (tsx strips types without checking them). */
export const typecheck = (modelPath: string) => {
  let dir = dirname(modelPath)
  while (!existsSync(join(dir, 'tsconfig.json'))) {
    const up = dirname(dir)
    if (up === dir) return process.stderr.write('pricesim: no tsconfig.json found; skipping type check\n')
    dir = up
  }
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' })
  if (r.status !== 0) fail(`type check failed:\n${r.stdout}${r.stderr}`)
}

export const loadScenario = async (modelPath: string): Promise<Scenario> => {
  const mod = (await import(pathToFileURL(modelPath).href)) as { default?: Scenario; scenario?: Scenario }
  const s = mod.default ?? mod.scenario
  if (!s || typeof s !== 'object' || !('workload' in s || 'tenants' in s))
    fail(`${modelPath} must export a scenario (default or 'scenario')`)
  return s!
}

export const usd = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const summarize = (r: Result): string => {
  const lines = [
    `${r.scenario} (${r.region}, ${r.period.hours} h in ${r.period.steps} steps)`,
    `total ${usd(r.total)}/month   used ${usd(r.used)}   idle ${usd(r.idle)}   fixed ${usd(r.fixed)}`,
    '',
  ]
  const walk = (n: CostNode, depth: number, maxDepth: number) => {
    if (depth > 0)
      lines.push(
        `${'  '.repeat(depth - 1)}${usd(n.cost).padStart(12)}  ${(n.share * 100).toFixed(1).padStart(5)}%  ${n.name}`,
      )
    if (depth < maxDepth) for (const c of n.children ?? []) walk(c, depth + 1, maxDepth)
  }
  walk(r.tree, 0, 3)
  if (r.tenants) {
    const ts = [...r.tenants].sort((a, b) => b.total - a.total)
    const shown = ts.slice(0, 10)
    lines.push('', `tenants (${ts.length}; idle and fixed allocated in proportion to used):`)
    for (const t of shown) lines.push(`  ${t.id.padEnd(24)} ${usd(t.total).padStart(12)}  (used ${usd(t.used)})`)
    if (ts.length > shown.length) {
      const rest = ts.slice(shown.length).reduce((a, t) => a + t.total, 0)
      lines.push(`  ${`… ${ts.length - shown.length} more`.padEnd(24)} ${usd(rest).padStart(12)}`)
    }
  }
  if (r.revenue) {
    const rv = r.revenue
    const pct = (x: number | null) => (x === null ? '–' : `${(x * 100).toFixed(1)}%`)
    lines.push(
      '',
      `revenue (${rv.priceBook}): ${usd(rv.revenue)}/month   provider cost ${usd(rv.cost)}   margin ${usd(rv.margin)} (${pct(rv.marginRate)})`,
    )
    for (const m of rv.meters) {
      lines.push(
        `  ${m.name.padEnd(24)} revenue ${usd(m.revenue).padStart(12)}  cost ${usd(m.cost).padStart(12)}  margin ${usd(m.margin).padStart(12)}`,
      )
    }
    if (rv.unallocated)
      lines.push(`  ${'unallocated cost'.padEnd(24)} ${''.padStart(20)}  cost ${usd(rv.unallocated).padStart(12)}`)
    if (rv.customers.length > 1) {
      const cs = [...rv.customers].sort((a, b) => b.revenue - a.revenue)
      const shown = cs.slice(0, 10)
      lines.push('', `customers (${cs.length}):`)
      for (const c of shown) {
        lines.push(
          `  ${c.id.padEnd(24)} revenue ${usd(c.revenue).padStart(12)}  cost ${usd(c.cost).padStart(12)}  margin ${pct(c.marginRate).padStart(7)}`,
        )
      }
      if (cs.length > shown.length) lines.push(`  … ${cs.length - shown.length} more`)
    }
  }
  lines.push('', 'capacity:')
  for (const p of r.pools) {
    const what = p.kind === 'pods' ? `pods on ${p.nodePool}` : `${p.instance}`
    lines.push(`  ${p.name.padEnd(28)} ${String(p.count).padStart(4)} × ${what}  (binding: ${p.binding}, min ${p.min})`)
  }
  return lines.join('\n') + '\n'
}

export const unitCostTable = (rs: readonly UnitCost[]): string => {
  const lines = [
    `${'request'.padEnd(16)}${'total/mo'.padStart(12)}${'used'.padStart(12)}${'idle'.padStart(11)}${'fixed'.padStart(10)}${'$/M used'.padStart(11)}${'$/M all-in'.padStart(12)}`,
  ]
  for (const r of rs) {
    lines.push(
      `${r.request.padEnd(16)}${usd(r.total).padStart(12)}${usd(r.used).padStart(12)}${usd(r.idle).padStart(11)}${usd(r.fixed).padStart(10)}${usd(r.perMillion.used).padStart(11)}${usd(r.perMillion.allIn).padStart(12)}`,
    )
    const top = [...r.breakdown].sort((a, b) => b.cost - a.cost).slice(0, 4)
    lines.push(`${''.padEnd(16)}used by: ${top.map((b) => `${b.name} ${usd(b.cost)}`).join(', ')}`)
  }
  return lines.join('\n') + '\n'
}

export const closedSummary = (name: string, cf: ClosedForm): string => {
  const kept = cf.symbols.filter((s) => s.kept)
  const lines = [
    `${name}: total ${cf.unit} (${cf.mode})`,
    '',
    `  = ${cf.expression}`,
    '',
    `at the scenario's values: ${usd(cf.value)}   (numeric evaluation: ${usd(cf.numericTotal)})`,
    '',
    'kept symbols (base units):',
    ...kept.map((s) => `  ${s.id.padEnd(28)} = ${String(Number(s.value.toPrecision(6))).padStart(12)} ${s.unit}`),
  ]
  if (cf.linear) {
    lines.push('', 'linear form:', `  constant ${usd(cf.linear.constant)}`)
    for (const [id, v] of Object.entries(cf.linear.perUnit)) lines.push(`  ${id.padEnd(28)} ${usd(v)} per unit`)
  }
  lines.push('', 'assumptions:', ...cf.assumptions.map((a) => `  - ${a}`))
  return lines.join('\n') + '\n'
}

export const writeJson = (value: unknown, jsonPath: string | undefined) => {
  const json = JSON.stringify(value, null, 2) + '\n'
  if (jsonPath) {
    writeFileSync(jsonPath, json)
    process.stderr.write(`\nwrote ${jsonPath}\n`)
  } else process.stdout.write(json)
}

export const round = <T>(v: T): T =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isInteger(x) ? Number(x.toPrecision(6)) : x)),
  )

export interface ModelArgs {
  readonly values: Record<string, string | boolean | (string | boolean)[] | undefined>
  readonly flags: ReadonlySet<string>
  /** --json given (with or without a path) */
  readonly json: boolean
  readonly jsonPath: string | undefined
  readonly csv: boolean
  readonly csvPath: string | undefined
  readonly scenario: Scenario
}

/** Parse a model command's arguments, type-check the model file and load its scenario. */
export const modelArgs = async (
  cmd: string,
  args: readonly string[],
  options: Record<string, { type: 'string'; multiple?: boolean }>,
): Promise<ModelArgs> => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { json: { type: 'string' }, csv: { type: 'string' }, ...options },
    strict: false,
  })
  // allow bare --json / --csv (write to stdout)
  const jsonPath = typeof values.json === 'string' && !values.json.startsWith('--') ? values.json : undefined
  const csvPath = typeof values.csv === 'string' && !values.csv.startsWith('--') ? values.csv : undefined
  // a value-less --json followed by another flag must not swallow that flag as a positional/path
  const model = positionals.find((p) => p !== jsonPath && p !== csvPath) ?? fail(`${cmd}: missing <model.ts>`)
  const modelPath = resolve(model!)
  if (!existsSync(modelPath)) fail(`no such file: ${model}`)
  if (!args.includes('--no-typecheck')) typecheck(modelPath)
  return {
    values,
    flags: new Set(args.filter((a) => a.startsWith('--'))),
    json: args.includes('--json'),
    jsonPath,
    csv: args.includes('--csv'),
    csvPath,
    scenario: await loadScenario(modelPath),
  }
}
