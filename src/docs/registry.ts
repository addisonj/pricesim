// Inline API documentation. Each module registers its public exports right after defining them, with
// `doc({ … })`; the CLI reads the registry (`pricesim api`, `pricesim describe <name>`) and `pnpm gen:api`
// renders it to docs/api.md. test/docs.test.ts checks that every runtime export of every entry point has an
// entry, so the registry is the API reference.

export interface ParamDoc {
  /** a positional parameter, or `spec.field` / `opts.field` for a property of an options object */
  readonly name: string
  /** the type as a reader would write it (units spelled out: `Expr<byte/s>`), not the full generic type */
  readonly type: string
  readonly doc: string
  readonly optional?: boolean
  /** the default, when optional and not obvious from `doc` */
  readonly default?: string
}

export type ApiKind = 'function' | 'class' | 'const' | 'type' | 'catalog'

export interface ApiDoc {
  /** the exported name */
  readonly name: string
  readonly kind: ApiKind
  /** the import path that exports it, e.g. `pricesim/model` or `pricesim/aws` */
  readonly module: string
  /** one line: what it is, not how it works */
  readonly summary: string
  /** simplified signature; unit-only type parameters left out */
  readonly signature?: string
  readonly params?: readonly ParamDoc[]
  readonly returns?: string
  /** markdown: when to use it, how it behaves, what goes wrong */
  readonly guidance?: string
  /** short TypeScript snippets; they should compile as written given the imports they show */
  readonly examples?: readonly string[]
  /** other documented names */
  readonly seeAlso?: readonly string[]
  /** `pricesim guide <topic>` that covers it */
  readonly guide?: string
  /** exported for other modules or tests; listed only with `pricesim api --all` */
  readonly internal?: boolean
}

const registry = new Map<string, ApiDoc>()

/** Register the documentation for an export. Names are unique across the package. */
export const doc = (d: ApiDoc): void => {
  const prev = registry.get(d.name)
  if (prev && prev.module !== d.module)
    throw new Error(`doc: '${d.name}' is documented twice (${prev.module}, ${d.module})`)
  registry.set(d.name, d)
}

/** Document several exports at once (e.g. the small helpers of one module). */
export const docs = (ds: readonly ApiDoc[]): void => ds.forEach(doc)

export const allDocs = (): readonly ApiDoc[] => [...registry.values()].sort((a, b) => a.name.localeCompare(b.name))

export const findDoc = (name: string): ApiDoc | undefined => registry.get(name)

/** Case-insensitive search over names, summaries and modules; exact name matches first. */
export const searchDocs = (query: string, opts: { internal?: boolean } = {}): readonly ApiDoc[] => {
  const q = query.toLowerCase()
  const hits = allDocs().filter(
    (d) =>
      (opts.internal || !d.internal) &&
      (d.name.toLowerCase().includes(q) || d.summary.toLowerCase().includes(q) || d.module.includes(q)),
  )
  return hits.sort((a, b) => Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q))
}

/** Markdown for one entry, as `pricesim describe` prints it. */
export const renderDoc = (d: ApiDoc): string => {
  const out = [`# ${d.name}`, '', `${d.kind} · \`import { ${d.name} } from '${d.module}'\``, '', d.summary]
  if (d.signature) out.push('', '```ts', d.signature, '```')
  if (d.params?.length) {
    out.push('', '## Parameters', '')
    for (const p of d.params) {
      const opt = p.optional ? ` (optional${p.default ? `, default ${p.default}` : ''})` : ''
      out.push(`- \`${p.name}\`: \`${p.type}\`${opt}. ${p.doc}`)
    }
  }
  if (d.returns) out.push('', '## Returns', '', d.returns)
  if (d.guidance) out.push('', '## Guidance', '', d.guidance.trim())
  if (d.examples?.length) {
    out.push('', '## Examples')
    for (const e of d.examples) out.push('', '```ts', e.trim(), '```')
  }
  const refs = [
    ...(d.seeAlso ?? []).map((s) => `\`pricesim describe ${s}\``),
    ...(d.guide ? [`\`pricesim guide ${d.guide}\``] : []),
  ]
  if (refs.length) out.push('', `See also: ${refs.join(', ')}`)
  return out.join('\n') + '\n'
}

docs([
  {
    name: 'doc',
    kind: 'function',
    module: 'pricesim/docs',
    summary: 'Register the documentation for one export, right after defining it.',
    signature: 'doc(d: ApiDoc): void',
    params: [{ name: 'd', type: 'ApiDoc', doc: 'The entry; `name`, `kind`, `module` and `summary` are required.' }],
    guidance: `
- Names are unique across the package: documenting a name again from a different \`module\` throws; from the same module it replaces the entry.
- \`module\` is the import path readers should use (\`pricesim\`, \`pricesim/model\`, \`pricesim/aws\`, …); test/docs.test.ts checks that it really exports the name.
- \`examples\` are compiled by the tests, each as its own module, so they must import what they use from package paths.
- Mark helpers that model authors don't need \`internal: true\`: \`pricesim api\` lists them only with \`--all\`.`,
    examples: [
      `import { doc } from 'pricesim/docs'

export const answer = 42
doc({ name: 'answer', kind: 'const', module: 'my-models', summary: 'The answer.' })`,
    ],
    seeAlso: ['docs', 'ApiDoc'],
  },
  {
    name: 'docs',
    kind: 'function',
    module: 'pricesim/docs',
    summary: 'Register several entries at once, e.g. the small helpers at the end of a module.',
    signature: 'docs(ds: ApiDoc[]): void',
    seeAlso: ['doc'],
  },
  {
    name: 'allDocs',
    kind: 'function',
    module: 'pricesim/docs',
    summary: 'Every registered entry, sorted by name (internal ones included).',
    signature: 'allDocs(): ApiDoc[]',
    guidance: '- Only modules that have been imported have registered their entries.',
    seeAlso: ['findDoc', 'searchDocs'],
  },
  {
    name: 'findDoc',
    kind: 'function',
    module: 'pricesim/docs',
    summary: 'The entry for an exact export name, or undefined.',
    signature: 'findDoc(name: string): ApiDoc | undefined',
    seeAlso: ['searchDocs', 'renderDoc'],
  },
  {
    name: 'searchDocs',
    kind: 'function',
    module: 'pricesim/docs',
    summary:
      'Case-insensitive substring search over entry names, summaries and modules; an exact name match comes first.',
    signature: 'searchDocs(query: string, opts?: { internal?: boolean }): ApiDoc[]',
    params: [
      { name: 'query', type: 'string', doc: 'Text to look for.' },
      {
        name: 'opts.internal',
        type: 'boolean',
        optional: true,
        default: 'false',
        doc: 'Include entries marked `internal`.',
      },
    ],
    seeAlso: ['findDoc', 'allDocs'],
  },
  {
    name: 'renderDoc',
    kind: 'function',
    module: 'pricesim/docs',
    summary: 'Markdown for one entry, as `pricesim describe <name>` prints it.',
    signature: 'renderDoc(d: ApiDoc): string',
    examples: [
      `import { findDoc, renderDoc } from 'pricesim/docs'
import 'pricesim'

const d = findDoc('q')
if (d) console.log(renderDoc(d))`,
    ],
    seeAlso: ['findDoc'],
  },
  {
    name: 'ApiDoc',
    kind: 'type',
    module: 'pricesim/docs',
    summary:
      'One documentation entry: name, kind, module, summary, and optional signature, params, returns, guidance, examples, seeAlso, guide, internal.',
    seeAlso: ['doc'],
  },
  {
    name: 'ParamDoc',
    kind: 'type',
    module: 'pricesim/docs',
    summary: 'One parameter of an entry: name (`spec.field` for option objects), type, doc, optional, default.',
    internal: true,
  },
  {
    name: 'ApiKind',
    kind: 'type',
    module: 'pricesim/docs',
    summary: "An entry's kind: 'function', 'class', 'const', 'type' or 'catalog'.",
    internal: true,
  },
])
