// The inline API documentation (src/docs/registry.ts) is the reference, so check it like code: every runtime
// export of every entry point is documented, each entry names an import path that really exports it, its
// cross-references resolve, its examples compile, and docs/api.md is up to date.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as main from '../src/index.ts'
import * as units from '../src/core/units.ts'
import * as expr from '../src/core/expr.ts'
import * as model from '../src/model/index.ts'
import * as workload from '../src/workload/index.ts'
import * as evaluation from '../src/eval/index.ts'
import * as aws from '../src/catalog/aws/index.ts'
import * as docsEntry from '../src/docs/index.ts'
import { allDocs, findDoc } from '../src/docs/registry.ts'
import { allCommands } from '../src/cli/command.ts'
import '../src/cli/model-commands.ts'
import '../src/cli/init-command.ts'
import { loadGuides } from '../src/cli/doc-commands.ts'
import { renderApiMarkdown } from '../scripts/gen-api.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

/** import path → module namespace, as package.json "exports" maps them */
const ENTRIES: Record<string, Record<string, unknown>> = {
  pricesim: main,
  'pricesim/units': units,
  'pricesim/expr': expr,
  'pricesim/model': model,
  'pricesim/workload': workload,
  'pricesim/eval': evaluation,
  'pricesim/aws': aws,
  'pricesim/docs': docsEntry,
}

const guides = new Set(loadGuides().map((g) => g.topic))
const commands = new Set(allCommands().map((c) => c.name))

describe('API documentation', () => {
  it('documents every runtime export of every entry point', () => {
    const missing = Object.entries(ENTRIES).flatMap(([path, ns]) =>
      Object.keys(ns)
        .filter((name) => !findDoc(name))
        .map((name) => `${name} (${path})`),
    )
    expect(missing).toEqual([])
  })

  it('names an import path that exports each documented runtime value', () => {
    const wrong = allDocs()
      .filter((d) => d.kind !== 'type')
      .filter((d) => !(d.module in ENTRIES) || !(d.name in ENTRIES[d.module]!))
      .map((d) => `${d.name}: ${d.module}`)
    expect(wrong).toEqual([])
  })

  it('has a summary, and cross-references that resolve', () => {
    const bad: string[] = []
    for (const d of allDocs()) {
      if (!d.summary.trim()) bad.push(`${d.name}: empty summary`)
      for (const s of d.seeAlso ?? []) if (!findDoc(s) && !commands.has(s)) bad.push(`${d.name}: seeAlso '${s}'`)
      if (d.guide && !guides.has(d.guide)) bad.push(`${d.name}: guide '${d.guide}'`)
    }
    expect(bad).toEqual([])
  })

  it('has examples (and guide code blocks) that compile', () => {
    const dir = join(root, 'test', `.doc-examples-${process.pid}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const files: string[] = []
    for (const d of allDocs()) {
      d.examples?.forEach((e, i) => {
        const f = `${d.name}-${i}.ts`
        // every example is its own module, so top-level names don't collide
        writeFileSync(join(dir, f), `${e.trim()}\n\nexport {}\n`)
        files.push(f)
      })
    }
    // complete ```ts blocks in the guides compile too (a block starting with `// fragment` is skipped)
    for (const g of loadGuides()) {
      ;[...g.body.matchAll(/```ts\n([\s\S]*?)```/g)].forEach((m, i) => {
        if (m[1]!.startsWith('// fragment')) return
        const f = `guide-${g.topic}-${i}.ts`
        writeFileSync(join(dir, f), `${m[1]!.trim()}\n\nexport {}\n`)
        files.push(f)
      })
    }
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ extends: '../../tsconfig.json', include: files, compilerOptions: { noUnusedLocals: false } }),
    )
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
    const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' })
    expect(r.stdout + r.stderr).toBe('')
    rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('is rendered to docs/api.md (pnpm gen:api)', () => {
    expect(readFileSync(join(root, 'docs', 'api.md'), 'utf8')).toBe(renderApiMarkdown())
  })
})

describe('CLI documentation', () => {
  it('gives every command a summary and usage, and resolves guide references', () => {
    const bad: string[] = []
    for (const c of allCommands()) {
      if (!c.summary || !c.usage) bad.push(`${c.name}: summary/usage`)
      for (const s of c.seeAlso ?? []) {
        const [what, arg] = s.split(' ')
        if (what === 'guide' && arg && !guides.has(arg)) bad.push(`${c.name}: guide '${arg}'`)
        if (what === 'describe' && arg && !arg.startsWith('--') && !findDoc(arg))
          bad.push(`${c.name}: describe '${arg}'`)
      }
    }
    expect(bad).toEqual([])
  })

  it('has a guide for every topic the guides link to', () => {
    const bad: string[] = []
    for (const g of loadGuides())
      for (const m of g.body.matchAll(/pricesim guide ([a-z-]+)/g))
        if (!guides.has(m[1]!)) bad.push(`${g.topic} → ${m[1]}`)
    expect(bad).toEqual([])
  })
})
