// CLI commands are registered with their documentation: `pricesim <cmd> --help` prints the usage and options,
// `pricesim <cmd> --describe` adds the guidance and examples, and `pricesim --help` lists every command.

export interface OptionDoc {
  /** as typed, with its value, e.g. `--rate <req/s>` or `--json [out.json]` */
  readonly flag: string
  readonly doc: string
}

export interface ExampleDoc {
  readonly command: string
  /** what it shows, one line */
  readonly doc: string
}

export interface Command {
  readonly name: string
  /** one line */
  readonly summary: string
  /** the argument pattern after the command name, e.g. `<model.ts> [options]` */
  readonly usage: string
  readonly options?: readonly OptionDoc[]
  /** markdown: when to use it, how to read its output, what to watch for */
  readonly guidance?: string
  readonly examples?: readonly ExampleDoc[]
  /** guides and API entries to read next */
  readonly seeAlso?: readonly string[]
  readonly run: (args: readonly string[]) => Promise<void> | void
}

const commands = new Map<string, Command>()

export const command = (c: Command): Command => {
  if (commands.has(c.name)) throw new Error(`command '${c.name}' is defined twice`)
  commands.set(c.name, c)
  return c
}

export const allCommands = (): readonly Command[] => [...commands.values()]
export const findCommand = (name: string): Command | undefined => commands.get(name)

export const renderHelp = (c: Command): string => {
  const out = [`usage: pricesim ${c.name} ${c.usage}`, '', c.summary]
  if (c.options?.length) {
    out.push('', 'options:')
    const w = Math.min(34, Math.max(...c.options.map((o) => o.flag.length)))
    for (const o of c.options) {
      const pad = o.flag.length > w ? `\n  ${' '.repeat(w)}` : ' '.repeat(w - o.flag.length)
      out.push(`  ${o.flag}${pad}  ${o.doc}`)
    }
  }
  out.push('', `More: pricesim ${c.name} --describe`)
  return out.join('\n') + '\n'
}

/** Markdown: usage, options, guidance and examples. */
export const renderDescribe = (c: Command): string => {
  const out = [`# pricesim ${c.name}`, '', c.summary, '', '```', `pricesim ${c.name} ${c.usage}`, '```']
  if (c.options?.length) {
    out.push('', '## Options', '')
    for (const o of c.options) out.push(`- \`${o.flag}\`: ${o.doc}`)
  }
  if (c.guidance) out.push('', '## Guidance', '', c.guidance.trim())
  if (c.examples?.length) {
    out.push('', '## Examples', '')
    for (const e of c.examples) out.push(`- ${e.doc}`, '', '  ```sh', `  ${e.command}`, '  ```', '')
    out.pop()
  }
  if (c.seeAlso?.length) out.push('', `See also: ${c.seeAlso.map((s) => `\`pricesim ${s}\``).join(', ')}`)
  return out.join('\n') + '\n'
}
