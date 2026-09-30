// Browser-safety guard (PLAN M4.2): nothing under src/ except src/cli/ may depend on Node. Scans every
// import/export/dynamic-import specifier for Node built-ins and the source for Node-only globals.
import { readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'src')
/** directories allowed to use Node (relative to src/) */
const NODE_ALLOWED = ['cli']

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.[cm]?tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  )

const files = walk(src).filter((f) => !NODE_ALLOWED.some((d) => relative(src, f).split(sep)[0] === d))

/** bare names of Node built-ins, e.g. 'fs', 'fs/promises', 'child_process' */
const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, '')))
const isNodeBuiltin = (spec: string): boolean =>
  spec.startsWith('node:') || builtins.has(spec) || builtins.has(spec.split('/')[0]!)

/** module specifiers of static imports/exports (incl. `import type`), dynamic `import()` and `require()` */
const specifiers = (code: string): string[] => {
  const out: string[] = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) for (const m of code.matchAll(re)) out.push(m[1]!)
  return out
}

/** Node-only globals; a browser build has none of them */
const NODE_GLOBALS = /\b(?:process\s*\.|Buffer\s*\.|__dirname\b|__filename\b|require\s*\()/

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1')

describe('browser safety', () => {
  it('scans the whole library', () => {
    expect(files.length).toBeGreaterThan(20)
    expect(files.some((f) => f.endsWith(join('eval', 'evaluate.ts')))).toBe(true)
  })

  it('detects Node imports', () => {
    const code = `import { a } from 'node:fs'\nimport type { B } from "path"\nexport * from 'fs/promises'\nconst x = await import('child_process')\nimport { q } from './expr.ts'\nimport { simplify } from 'mathjs'`
    expect(specifiers(code).filter(isNodeBuiltin)).toEqual(['node:fs', 'path', 'fs/promises', 'child_process'])
  })

  it.each(files.map((f) => [relative(root, f), f]))('%s imports no Node built-ins', (_name, file) => {
    const code = stripComments(readFileSync(file, 'utf8'))
    expect(specifiers(code).filter(isNodeBuiltin)).toEqual([])
    expect(code.match(NODE_GLOBALS)?.[0]).toBeUndefined()
  })
})
