// Commands that document the library itself: api (list), describe (one entry), guide (how to write models).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { allDocs, findDoc, renderDoc, searchDocs, type ApiDoc } from '../docs/registry.ts'
import { allCommands, command, findCommand, renderDescribe } from './command.ts'
import { fail } from './util.ts'

export const GUIDES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'guides')

export interface Guide {
  readonly topic: string
  readonly title: string
  readonly summary: string
  /** order in the list (lower first) */
  readonly order: number
  readonly body: string
}

/** Guides are guides/<topic>.md with a front matter of title, summary and order. */
export const loadGuides = (): Guide[] => {
  if (!existsSync(GUIDES_DIR)) return []
  return readdirSync(GUIDES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = readFileSync(join(GUIDES_DIR, f), 'utf8')
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
      const meta: Record<string, string> = {}
      for (const line of (m?.[1] ?? '').split('\n')) {
        const i = line.indexOf(':')
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      return {
        topic: f.slice(0, -3),
        title: meta.title ?? f.slice(0, -3),
        summary: meta.summary ?? '',
        order: Number(meta.order ?? 100),
        body: m ? text.slice(m[0].length) : text,
      }
    })
    .sort((a, b) => a.order - b.order || a.topic.localeCompare(b.topic))
}

const flag = (args: readonly string[], f: string) => args.includes(f)

command({
  name: 'guide',
  summary: 'How to write model code: concepts, patterns and pitfalls, one topic at a time.',
  usage: '[<topic>]',
  guidance: `
Without a topic, lists the topics. Guides explain how the pieces fit and how to write the code; for the exact parameters of one function, use \`pricesim describe <name>\`. Start with \`overview\`, then \`model-file\`.`,
  examples: [
    { command: 'pricesim guide', doc: 'List the topics.' },
    { command: 'pricesim guide capacity', doc: 'Instance pools, node pools and pods.' },
  ],
  seeAlso: ['api --describe', 'describe --describe'],
  run: (args) => {
    const guides = loadGuides()
    const topic = args.find((a) => !a.startsWith('--'))
    if (!topic) {
      const w = Math.max(...guides.map((g) => g.topic.length))
      process.stdout.write(
        `pricesim guides (pricesim guide <topic>):\n\n${guides.map((g) => `  ${g.topic.padEnd(w)}  ${g.summary}`).join('\n')}\n`,
      )
      return
    }
    const g = guides.find((x) => x.topic === topic)
    if (!g) fail(`guide: no topic '${topic}'; topics: ${guides.map((x) => x.topic).join(', ')}`)
    process.stdout.write(`# ${g!.title}\n\n${g!.body.trim()}\n`)
  },
})

const MODULE_ORDER = ['pricesim', 'pricesim/model', 'pricesim/aws', 'pricesim/docs']
const moduleRank = (m: string) => (MODULE_ORDER.indexOf(m) + 1 || 99) * 1000

const listing = (ds: readonly ApiDoc[]): string => {
  const out: string[] = []
  const byModule = new Map<string, ApiDoc[]>()
  for (const d of ds) byModule.set(d.module, [...(byModule.get(d.module) ?? []), d])
  const mods = [...byModule.keys()].sort((a, b) => moduleRank(a) - moduleRank(b) || a.localeCompare(b))
  for (const m of mods) {
    const entries = byModule.get(m)!
    const w = Math.min(28, Math.max(...entries.map((d) => d.name.length)))
    out.push(`${m}:`)
    for (const d of entries)
      out.push(`  ${d.name.padEnd(w)}  ${d.kind === 'function' ? '' : `[${d.kind}] `}${d.summary}`)
    out.push('')
  }
  return out.join('\n')
}

command({
  name: 'api',
  summary: 'List the documented API: every export with a one-line summary, grouped by import path.',
  usage: '[<query>] [--module <import path>] [--all] [--json]',
  options: [
    { flag: '<query>', doc: 'Only entries whose name, summary or module contains it (case-insensitive).' },
    { flag: '--module <path>', doc: 'Only one import path, e.g. pricesim/aws.' },
    { flag: '--all', doc: 'Include internal exports (used between modules and by tests).' },
    { flag: '--json', doc: 'The full entries (params, guidance, examples) as JSON.' },
  ],
  guidance: `
Use it to find the name you need, then \`pricesim describe <name>\` for its parameters, guidance and examples. The AWS catalog is under \`pricesim/aws\`: \`pricesim api --module pricesim/aws\`.`,
  examples: [
    { command: 'pricesim api pool', doc: 'Everything about pools.' },
    { command: 'pricesim api --module pricesim/aws', doc: 'The AWS catalog.' },
  ],
  seeAlso: ['describe --describe', 'guide'],
  run: (args) => {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { module: { type: 'string' } },
      strict: false,
    })
    const all = flag(args, '--all')
    let ds = positionals[0]
      ? searchDocs(positionals[0], { internal: all })
      : allDocs().filter((d) => all || !d.internal)
    if (typeof values.module === 'string') ds = ds.filter((d) => d.module === values.module)
    if (flag(args, '--json')) return void process.stdout.write(JSON.stringify(ds, null, 2) + '\n')
    if (!ds.length) fail(`api: nothing matches${positionals[0] ? ` '${positionals[0]}'` : ''}`)
    process.stdout.write(listing(ds) + 'Details: pricesim describe <name>\n')
  },
})

command({
  name: 'describe',
  summary: 'Full documentation of one export (parameters, guidance, examples) or of one CLI command.',
  usage: '<name> [--json]',
  options: [{ flag: '--json', doc: 'The entry as JSON.' }],
  guidance: `
\`<name>\` is an exported name (\`instancePool\`, \`scenario\`, \`ec2\`) or a command (\`sweep\`, same as \`pricesim sweep --describe\`). Examples in API entries compile as written (a test checks them), so they are safe starting points to copy. When a name isn't found, close matches are suggested.`,
  examples: [
    { command: 'pricesim describe instancePool', doc: 'How to declare and size an instance pool.' },
    { command: 'pricesim describe priceBook --json', doc: 'As JSON.' },
  ],
  seeAlso: ['api --describe', 'guide'],
  run: (args) => {
    const name = args.find((a) => !a.startsWith('--')) ?? fail('describe: missing <name>')
    const d = findDoc(name!)
    if (d) {
      if (flag(args, '--json')) return void process.stdout.write(JSON.stringify(d, null, 2) + '\n')
      return void process.stdout.write(renderDoc(d))
    }
    const c = findCommand(name!)
    if (c) return void process.stdout.write(renderDescribe(c))
    const near = searchDocs(name!, { internal: true }).slice(0, 8)
    fail(
      `describe: no export or command '${name}'${near.length ? `; did you mean: ${near.map((x) => x.name).join(', ')}` : ''}\n(pricesim api lists everything)`,
    )
  },
})

export const topLevelHelp = (): string => {
  const cmds = allCommands()
  const w = Math.max(...cmds.map((c) => c.name.length))
  return `usage: pricesim <command> [options]

Model the cost of running workloads on cloud infrastructure, and price them.

commands:
${cmds.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`).join('\n')}

Learn it from the CLI:
  pricesim guide                 topics on writing models (start with: pricesim guide overview)
  pricesim api [query]           every export, one line each
  pricesim describe <name>       one export or command in full
  pricesim <command> --help      usage and options;  --describe adds guidance and examples
`
}
