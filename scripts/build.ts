// Compile src/ to dist/ (JavaScript + declarations) for the npm package. The repo and git-dependency installs use
// the TypeScript sources directly; package.json's publishConfig points the published exports and bin at dist/.
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
rmSync(`${root}dist`, { recursive: true, force: true })
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const r = spawnSync(process.execPath, [tsc, '-p', `${root}tsconfig.build.json`], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)

// the source CLI runs under tsx; the compiled one runs on Node
const bin = `${root}dist/cli/main.js`
writeFileSync(bin, readFileSync(bin, 'utf8').replace(/^#!.*\n/, '#!/usr/bin/env node\n'))
chmodSync(bin, 0o755)
process.stdout.write('built dist/\n')
