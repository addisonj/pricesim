// The project templates `pricesim init` writes: both models evaluate, and init writes a complete project.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluate } from '../src/index.ts'
import minimal from '../templates/minimal/model.ts'
import example from '../templates/example/model.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('templates', () => {
  it('evaluate the minimal model', () => {
    expect(evaluate(minimal).total).toBeGreaterThan(0)
  })
  it('evaluate the worked example, with revenue', () => {
    const r = evaluate(example)
    expect(r.total).toBeGreaterThan(0)
    expect(r.revenue!.revenue).toBeGreaterThan(0)
  })
})

describe('pricesim init', () => {
  it('writes a project with the pricesim dependency it is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pricesim-init-'))
    try {
      const r = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          join(root, 'src/cli/main.ts'),
          'init',
          dir,
          '--example',
          '--force',
          '--pricesim',
          'link:/x',
        ],
        { encoding: 'utf8', cwd: root },
      )
      expect(r.status, r.stderr).toBe(0)
      for (const f of ['package.json', 'tsconfig.json', 'model.ts', 'report.ts', 'README.md', 'CLAUDE.md'])
        expect(existsSync(join(dir, f)), f).toBe(true)
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      expect(pkg.dependencies.pricesim).toBe('link:/x')
      expect(pkg.scripts.report).toBe('tsx report.ts')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
