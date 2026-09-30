// Commands that evaluate a model file: eval, unit-cost, closed, sweep, capacity.
import { writeFileSync } from 'node:fs'
import { evaluate, roundResult } from '../eval/evaluate.ts'
import { unitCosts } from '../eval/unit-cost.ts'
import { closedForm, type ClosedForm } from '../eval/closed-form.ts'
import { parseRangeSpec, sweep, sweepCsv } from '../eval/sweep.ts'
import { capacity } from '../eval/capacity.ts'
import { command, type OptionDoc } from './command.ts'
import { closedSummary, fail, modelArgs, round, summarize, unitCostTable, usd, writeJson } from './util.ts'

const MODEL_FILE = `
**The model file** is a TypeScript module whose default export (or export named \`scenario\`) is a \`scenario({ … })\`. It is type-checked with the nearest \`tsconfig.json\` before it runs (tsx alone would strip types without checking them), so unit mismatches fail here, not as wrong numbers. See \`pricesim guide model-file\`.

**Output:** the human-readable summary goes to **stderr**; \`--json\` / \`--csv\` write machine-readable output to a file, or to **stdout** without one. All costs are USD per month (730 hours).`

const COMMON: readonly OptionDoc[] = [
  { flag: '--json [out.json]', doc: 'Also write the full result as JSON (to stdout without a path).' },
  {
    flag: '--no-typecheck',
    doc: 'Skip the type check of the model file (faster; use only for a file that already checks).',
  },
]

command({
  name: 'eval',
  summary:
    "Evaluate a model's scenario: the monthly cost tree, capacity per pool, and revenue and margin if it has a price book.",
  usage: '<model.ts> [--json [out.json]] [--no-typecheck]',
  options: COMMON,
  guidance: `
${MODEL_FILE}

**Reading the summary:**
- \`total = used + idle + fixed\`. *Used* is cost driven by requests and gauges; *idle* is capacity provisioned but not used (minimum sizes, rounding up to whole instances, load-factor headroom); *fixed* is time-based charges (load-balancer hours, cluster fees).
- The tree is root → request type (and \`gauges\`) → the services and offerings under it → billing dimensions; the printed tree stops at three levels, \`--json\` has all of it. Shared nodes appear under every request type that uses them.
- \`capacity:\` lists each pool's size and its *binding* resource (the one that needed the most instances); \`min\` means the minimum size, not load, set it.
- With tenants: the top tenants, with idle and fixed shared out in proportion to used cost. With a price book: revenue, cost and margin per meter and per customer; cost no meter covers is the \`unallocated\` line.

**JSON:** \`tree\` (full), \`dimensions\` (usage, list cost, cost, effective rate per billing dimension), \`pools\` (count, binding, peak/mean/capacity per resource), optional \`tenants\`, \`accounts\`, \`revenue\`. Specified by \`schema/result.schema.json\`.`,
  examples: [
    { command: 'pricesim eval model.ts', doc: 'Print the summary.' },
    {
      command: "pricesim eval model.ts --json | jq '.dimensions | sort_by(-.cost) | .[:5]'",
      doc: 'The five most expensive billing dimensions.',
    },
  ],
  seeAlso: ['guide analysis', 'describe evaluate', 'describe scenario'],
  run: async (args) => {
    const a = await modelArgs('eval', args, {})
    const result = roundResult(evaluate(a.scenario))
    process.stderr.write(summarize(result))
    if (a.json) writeJson(result, a.jsonPath)
  },
})

command({
  name: 'unit-cost',
  summary:
    'Cost of each root request type alone at a constant rate: request-driven cost, idle and fixed, per million requests.',
  usage: '<model.ts> [--rate <req/s>] [--request <name>]... [--with-gauges] [--json [out.json]] [--no-typecheck]',
  options: [
    { flag: '--rate <req/s>', doc: 'The constant rate each request type runs at (default 1000).' },
    { flag: '--request <name>', doc: 'Only this request type (repeatable; default all).' },
    { flag: '--with-gauges', doc: "Keep the scenario's gauges (stored bytes, streams, …) instead of zeroing them." },
    ...COMMON,
  ],
  guidance: `
${MODEL_FILE}

Each request type is evaluated **alone**, at a constant rate, with the scenario's attributes and without gauges (unless \`--with-gauges\`).
- **$/M used** is the request-driven cost per million requests: the marginal cost of that request type on a deployment that is already big enough.
- **$/M all-in** also spreads the whole deployment's idle and fixed cost over those requests: the minimum-size tax at that rate. Compare the two at a low and a high \`--rate\` to see where minimums stop mattering.
- \`used by:\` names the four largest cost centers of each request type.
- It is not the marginal cost inside a mixed workload (requests share pools); for that use \`pricesim closed --mode relaxed\` and read the linear form.`,
  examples: [
    { command: 'pricesim unit-cost model.ts --rate 100', doc: 'Unit costs at 100 req/s each.' },
    {
      command: 'pricesim unit-cost model.ts --request append --rate 10000 --json',
      doc: 'One request type at a high rate, as JSON.',
    },
  ],
  seeAlso: ['closed --describe', 'describe unitCosts'],
  run: async (args) => {
    const a = await modelArgs('unit-cost', args, {
      rate: { type: 'string' },
      request: { type: 'string', multiple: true },
    })
    const rate = a.values.rate === undefined ? 1000 : Number(a.values.rate)
    if (!(rate > 0)) fail(`unit-cost: --rate must be a positive number of req/s`)
    const requests = a.values.request as string[] | undefined
    const { results } = unitCosts(a.scenario, {
      rate,
      ...(requests ? { requests } : {}),
      includeGauges: a.flags.has('--with-gauges'),
    })
    process.stderr.write(
      `${a.scenario.name}: each request type alone at ${rate} req/s (${a.scenario.pricing.region}, USD/month)\n\n`,
    )
    process.stderr.write(unitCostTable(results))
    if (a.json) writeJson(round({ scenario: a.scenario.name, rate, results }), a.jsonPath)
  },
})

command({
  name: 'closed',
  summary: 'Total monthly cost as a simplified formula over the symbols you keep (rates, attributes, gauges, params).',
  usage: '<model.ts> [--mode exact|relaxed] [--keep <symbol>,…] [--json [out.json]] [--no-typecheck]',
  options: [
    {
      flag: '--mode exact|relaxed',
      doc: 'exact (default) keeps ceil() and minimum sizes; relaxed is continuous and linear in the rates.',
    },
    {
      flag: '--keep <symbol>,…',
      doc: 'Symbols left free: rate.<request>, <request>.<attr>, gauge.<name>, or a param name (default: every mean request rate).',
    },
    ...COMMON,
  ],
  guidance: `
${MODEL_FILE}

Everything not kept is bound to its value in the scenario. Symbols are in **base units** (req/s, bytes, seconds, millicores).
- **exact** equals the numeric total at the operating point but is piecewise: every pool appears as \`max(min, ceil(…))\`.
- **relaxed** drops pool rounding and minimum sizes, so it comes out *below* the numeric total by the minimum-size and rounding tax, and is reported as a **linear form**: "each extra unit of this symbol costs $X/month". \`ceil()\` inside billing expressions (request units, multipart PUT counts) stays even when relaxed.
- Each billing dimension is priced at its effective rate at the operating point, so volume tiers never enter the algebra; move far from the operating point and the formula drifts (re-run there, or use \`sweep\`).
- Capacity is sized from request peaks, assumed to coincide.
- Use it to explain *why* cost moves (which terms scale with what), and \`sweep\` to get numbers across a range.`,
  examples: [
    { command: 'pricesim closed model.ts --mode relaxed', doc: 'Linear cost per unit of each request rate.' },
    {
      command: 'pricesim closed model.ts --keep rate.upload,upload.bytes',
      doc: 'How the upload rate and upload size enter the total.',
    },
  ],
  seeAlso: ['sweep --describe', 'describe closedForm'],
  run: async (args) => {
    const a = await modelArgs('closed', args, { mode: { type: 'string' }, keep: { type: 'string' } })
    const mode = (a.values.mode as string | undefined) ?? 'exact'
    if (mode !== 'exact' && mode !== 'relaxed') fail(`closed: --mode must be exact or relaxed`)
    const keep =
      typeof a.values.keep === 'string'
        ? a.values.keep
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean)
        : undefined
    let cf: ClosedForm
    try {
      cf = closedForm(a.scenario, { mode: mode as 'exact' | 'relaxed', ...(keep ? { keep } : {}) })
    } catch (e) {
      return fail((e as Error).message)
    }
    process.stderr.write(closedSummary(a.scenario.name, cf))
    if (a.json) writeJson(round(cf), a.jsonPath)
  },
})

command({
  name: 'sweep',
  summary: 'Evaluate the scenario over a grid of values (rates, attributes, gauges, params) and tabulate the totals.',
  usage: '<model.ts> --var <name>=<spec> [--var …] [--csv [out.csv]] [--json [out.json]] [--no-typecheck]',
  options: [
    {
      flag: '--var <name>=<spec>',
      doc: 'A variable and its values: a..b[:log][:n] (n points, default 10) or v1,v2,…. Repeat for a cartesian product.',
    },
    {
      flag: '--csv [out.csv]',
      doc: 'Write one row per point: inputs, totals, cost per billing dimension, count per pool.',
    },
    ...COMMON,
  ],
  guidance: `
${MODEL_FILE}

**Variable names** (values in base units): \`rate.<request>\` (mean req/s; the series is rescaled to the new mean and keeps its shape), \`<request>.<attr>\` (a request attribute, e.g. \`upload.bytes\`), \`gauge.<name>\` (a root gauge level), or a \`param(…)\` name from the model.
- Use \`:log\` for anything that spans orders of magnitude (rates, sizes).
- The CSV is the thing to plot or pivot: a \`dim:<billing dimension>\` column per line of the bill and a \`pool:<name>\` column per pool, so you can see which line takes over as a variable grows and where pools step.
- Gauges derived from rates in the workload (e.g. retained bytes = rate × retention) follow the swept rate.
- A diurnal series over a 730 h period doesn't average exactly its nominal mean (730 h is not whole days), so a sweep point at the scenario's rate can differ slightly from \`eval\`.`,
  examples: [
    { command: 'pricesim sweep model.ts --var rate.upload=10..160:log:5', doc: 'Five upload rates, log-spaced.' },
    {
      command: 'pricesim sweep model.ts --var rate.upload=10,40 --var upload.bytes=1e5,1e6 --csv sweep.csv',
      doc: 'A 2 × 2 grid written to CSV.',
    },
  ],
  seeAlso: ['closed --describe', 'describe sweep'],
  run: async (args) => {
    const a = await modelArgs('sweep', args, { var: { type: 'string', multiple: true } })
    const specs = (a.values.var as string[] | undefined) ?? []
    if (!specs.length) fail('sweep: need at least one --var name=spec')
    const vars: Record<string, number[]> = {}
    for (const spec of specs) {
      const eq = spec.indexOf('=')
      if (eq < 0) fail(`sweep: --var must be name=spec, got '${spec}'`)
      try {
        vars[spec.slice(0, eq)] = parseRangeSpec(spec.slice(eq + 1))
      } catch (e) {
        fail((e as Error).message)
      }
    }
    let rows
    try {
      rows = sweep(a.scenario, vars)
    } catch (e) {
      return fail((e as Error).message)
    }
    const names = Object.keys(vars)
    process.stderr.write(`${a.scenario.name}: ${rows.length} points over ${names.join(' × ')}\n\n`)
    process.stderr.write(
      `${names.map((n) => n.padStart(20)).join('')}${'total/mo'.padStart(14)}${'idle'.padStart(12)}\n`,
    )
    for (const r of rows) {
      process.stderr.write(
        `${names.map((n) => String(Number(r.inputs[n]!.toPrecision(6))).padStart(20)).join('')}${usd(r.total).padStart(14)}${usd(r.idle).padStart(12)}\n`,
      )
    }
    if (a.csv) {
      const csv = sweepCsv(rows)
      if (a.csvPath) {
        writeFileSync(a.csvPath, csv)
        process.stderr.write(`\nwrote ${a.csvPath}\n`)
      } else process.stdout.write(csv)
    }
    if (a.json) writeJson(round(rows), a.jsonPath)
  },
})

command({
  name: 'capacity',
  summary:
    'How far a fixed deployment goes: the largest multiple of the scenario rates the pinned pools sustain, and what runs out.',
  usage: '<model.ts> --fix <pool>=<n>[,<pool>=<n>…] [--scale <request>[,…]] [--json [out.json]] [--no-typecheck]',
  options: [
    { flag: '--fix <pool>=<n>,…', doc: 'Pin pools (instance pools, pod groups or node pools, by name) at a size.' },
    { flag: '--scale <request>,…', doc: 'Scale only these request types (default: all together).' },
    ...COMMON,
  ],
  guidance: `
${MODEL_FILE}

The request rates are scaled together by a factor, found by bisection, until a pinned pool would need more than its size; the result names the pool and resource that run out and the cost at that point.
- A factor **below 1** means the pinned size is already too small for the scenario's load.
- Gauge-driven demand counts: gauges derived from rates (retention) grow with them, so memory or disk can bind before CPU.
- Pool names are the \`name\` given to \`instancePool\`, \`pods\` or \`nodePool\`; \`pricesim eval\` lists them under \`capacity:\`.`,
  examples: [
    { command: 'pricesim capacity model.ts --fix api=10', doc: 'Headroom of 10 API pods.' },
    {
      command: 'pricesim capacity model.ts --fix api=10,search-nodes=4 --scale upload',
      doc: 'How many uploads 4 search nodes can index.',
    },
  ],
  seeAlso: ['describe capacity'],
  run: async (args) => {
    const a = await modelArgs('capacity', args, { fix: { type: 'string' }, scale: { type: 'string' } })
    if (typeof a.values.fix !== 'string') fail('capacity: need --fix pool=n[,pool=n…]')
    const fix: Record<string, number> = {}
    for (const part of (a.values.fix as string).split(',')) {
      const eq = part.lastIndexOf('=')
      const n = Number(part.slice(eq + 1))
      if (eq < 0 || !Number.isInteger(n) || n < 1) fail(`capacity: bad --fix entry '${part}'`)
      fix[part.slice(0, eq)] = n
    }
    const scale = typeof a.values.scale === 'string' ? a.values.scale.split(',').map((x) => x.trim()) : undefined
    let res
    try {
      res = capacity(a.scenario, { fix, ...(scale ? { scale } : {}) })
    } catch (e) {
      return fail((e as Error).message)
    }
    const lines = [
      `${a.scenario.name}: capacity with ${Object.entries(fix)
        .map(([p, n]) => `${p}=${n}`)
        .join(', ')}`,
      '',
      `  ${res.factor.toFixed(3)}× the scenario's rates; runs out of ${res.binding.resource} on ${res.binding.pool}`,
      '',
      ...Object.entries(res.rates).map(([n, r]) => `  ${n.padEnd(20)} ${r.toFixed(1).padStart(12)} req/s (mean)`),
      '',
      `  cost at capacity: ${usd(res.result.total)}/month (idle ${usd(res.result.idle)})`,
    ]
    process.stderr.write(lines.join('\n') + '\n')
    if (a.json)
      writeJson(
        round({
          factor: res.factor,
          rates: res.rates,
          binding: res.binding,
          total: res.result.total,
          pools: res.result.pools,
        }),
        a.jsonPath,
      )
  },
})
