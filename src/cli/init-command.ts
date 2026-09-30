// `pricesim init`: stub out a model project (package.json, tsconfig, a model, a README) from templates/.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { command } from './command.ts'
import { fail } from './util.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string
  devDependencies: Record<string, string>
}

const README = (name: string, example: boolean) => `# ${name}

A cost model built with [pricesim](https://github.com/addisonj/pricesim).

\`\`\`sh
pnpm install
pnpm check                      # type check
pnpm exec pricesim eval model.ts${example ? '\npnpm report                     # price, cost and margin by customer size' : ''}
\`\`\`

## Learning pricesim

The CLI documents the library:

\`\`\`sh
pnpm exec pricesim guide              # topics: start with overview, then model-file
pnpm exec pricesim api <word>         # find a function or catalog offering
pnpm exec pricesim describe <name>    # its parameters, guidance and examples
pnpm exec pricesim <command> --describe
\`\`\`

## Working on pricesim at the same time

\`pnpm link <path to a pricesim checkout>\` points this project at your checkout (it adds an \`overrides\` entry to
\`pnpm-workspace.yaml\`; don't commit it). \`pnpm unlink pricesim\` goes back to the released version.
`

const CLAUDE = `# Agent guide

This is a pricesim cost model. Don't guess pricesim's API: run \`pnpm exec pricesim guide\`, \`pnpm exec pricesim api <word>\`
and \`pnpm exec pricesim describe <name>\` before using something new. The pricesim Claude Code skills
(\`/plugin marketplace add addisonj/pricesim\`) cover modeling, analysis and pricing.

- Run \`pnpm check\` and \`pnpm exec pricesim eval model.ts\` after every change.
- Keep uncertain inputs as \`param(…)\` so they can be swept, and say which numbers are guesses.
`

command({
  name: 'init',
  summary: 'Stub out a model project: package.json, tsconfig, a model file (or a full worked example) and a README.',
  usage: '[<dir>] [--example] [--pricesim <dependency spec>] [--force]',
  options: [
    {
      flag: '<dir>',
      doc: 'Where to create the project (default: the current directory). Must be empty unless --force.',
    },
    {
      flag: '--example',
      doc: 'A worked example (an event-ingestion service with a price book, a simulated customer base and a report script) instead of the minimal skeleton.',
    },
    {
      flag: '--pricesim <spec>',
      doc: `The pricesim dependency (default github:addisonj/pricesim#v${pkg.version}); e.g. link:../pricesim for a local checkout.`,
    },
    { flag: '--force', doc: 'Write into a non-empty directory (existing files with the same names are overwritten).' },
  ],
  guidance: `
Writes \`package.json\` (pricesim, TypeScript and tsx), \`pnpm-workspace.yaml\` (lets pnpm build tsx's esbuild), \`tsconfig.json\`, \`model.ts\`, \`README.md\`, \`CLAUDE.md\` and \`.gitignore\`; with \`--example\`, also \`report.ts\`. Then \`pnpm install\` and \`pnpm exec pricesim eval model.ts\`.

- The minimal model is the skeleton from \`pricesim guide model-file\`: one service on an instance pool, an S3 bucket, a workload and a scenario.
- The example shows most of the library at once: pods on a shared node pool, a storage tier with disks and cross-AZ replication, S3 archiving, attribute distributions, params you can sweep (\`traffic\`, \`ingestCpuPerMB\`, \`hotRetention\`), a price book with tiers, an option and a minimum, and a report over customer sizes and a simulated customer base.`,
  examples: [
    { command: 'pricesim init my-model', doc: 'A minimal project in ./my-model.' },
    { command: 'pricesim init demo --example && cd demo && pnpm install && pnpm report', doc: 'The worked example.' },
    { command: 'pricesim init my-model --pricesim link:../pricesim', doc: 'Against a local pricesim checkout.' },
  ],
  seeAlso: ['guide model-file'],
  run: (args) => {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { example: { type: 'boolean' }, force: { type: 'boolean' }, pricesim: { type: 'string' } },
      strict: true,
    })
    const dir = resolve(positionals[0] ?? '.')
    const example = values.example === true
    if (existsSync(dir) && readdirSync(dir).length && !values.force)
      fail(`init: ${dir} is not empty (use --force to write into it anyway)`)
    mkdirSync(dir, { recursive: true })
    const name =
      basename(dir)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-') || 'cost-model'
    const spec = values.pricesim ?? `github:addisonj/pricesim#v${pkg.version}`
    const dev = pkg.devDependencies
    const files: Record<string, string> = {
      'package.json': JSON.stringify(
        {
          name,
          version: '0.0.0',
          private: true,
          type: 'module',
          scripts: {
            check: 'tsc --noEmit',
            eval: 'pricesim eval model.ts',
            ...(example ? { report: 'tsx report.ts' } : {}),
          },
          dependencies: { pricesim: spec },
          devDependencies: {
            '@types/node': dev['@types/node']!,
            tsx: dev.tsx!,
            typescript: dev.typescript!,
          },
        },
        null,
        2,
      ),
      'pnpm-workspace.yaml': 'allowBuilds:\n  esbuild: true',
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022'],
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            verbatimModuleSyntax: true,
            skipLibCheck: true,
            types: ['node'],
          },
          include: ['*.ts', 'src'],
        },
        null,
        2,
      ),
      '.gitignore': 'node_modules/',
      'README.md': README(name, example),
      'CLAUDE.md': CLAUDE,
    }
    const template = join(ROOT, 'templates', example ? 'example' : 'minimal')
    for (const f of readdirSync(template)) files[f] = readFileSync(join(template, f), 'utf8')
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text.endsWith('\n') ? text : `${text}\n`)
    process.stdout.write(
      `created ${dir}: ${Object.keys(files).join(', ')}\n\nnext:\n  cd ${positionals[0] ?? '.'}\n  pnpm install\n  pnpm exec pricesim eval model.ts${example ? '\n  pnpm report' : ''}\n`,
    )
  },
})
