#!/usr/bin/env -S npx tsx
// `pricesim` CLI (DESIGN.md §9). Commands are registered with their documentation (command.ts); importing the
// library registers the API documentation that `api` and `describe` read.
import '../index.ts'
import '../catalog/aws/index.ts'
import { findCommand, renderDescribe, renderHelp } from './command.ts'
import './model-commands.ts'
import './init-command.ts'
import { topLevelHelp } from './doc-commands.ts'
import { fail } from './util.ts'

const main = async () => {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return void process.stdout.write(topLevelHelp())
  const c = findCommand(cmd) ?? fail(`unknown command '${cmd}'\n\n${topLevelHelp()}`)
  if (rest.includes('--describe')) return void process.stdout.write(renderDescribe(c!))
  if (rest.includes('--help') || rest.includes('-h')) return void process.stdout.write(renderHelp(c!))
  await c!.run(rest)
}

await main()
