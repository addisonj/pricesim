// Generates the checked-in AWS catalog data (DESIGN.md §5.4, PLAN.md 1.1/1.2/1.6):
//
//   src/catalog/aws/ec2-specs.gen.ts  instance specs (network, EBS, instance store) from Vantage's ec2instances.info
//   src/catalog/aws/ec2.gen.ts        EC2 Linux on-demand, standard RI and Compute Savings Plan rates
//   src/catalog/aws/s3.gen.ts         S3 rates (named usage types)
//   src/catalog/aws/dynamodb.gen.ts   DynamoDB rates (named usage types)
//   src/catalog/aws/aurora.gen.ts     Aurora PostgreSQL/MySQL instance, storage and I/O rates
//
// Run with `pnpm gen:aws`. Output is deterministic (sorted keys) so price changes show up as reviewable
// diffs. The EC2 catalog is limited to current-generation types (per ec2instances.info) that have a baseline
// network figure.
//
// Flags: --cache <dir>  keep downloaded sources in <dir> and reuse them on later runs (offline iteration)
//        --only a,b     generate only some outputs (ec2, s3, dynamodb, aurora)
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** Regions to generate. Only us-east-1 today; the library applies a regional multiplier elsewhere. */
const REGIONS = [{ code: 'us-east-1', name: 'US East (N. Virginia)' }] as const
type Region = (typeof REGIONS)[number]

const MUM = 'https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps'
const enc = (s: string) => encodeURIComponent(s)

const url = {
  ec2OnDemand: (r: Region) => `${MUM}/ec2/USD/current/ec2-ondemand-without-sec-sel/${enc(r.name)}/Linux/index.json`,
  ec2Reserved: (r: Region, term: Term, pay: Payment) =>
    `${MUM}/ec2/USD/current/ec2-reservedinstance/${enc(TERM_LABEL[term])}/${enc(PAY_LABEL[pay])}/${enc(r.name)}/Linux/Shared/index.json`,
  ec2SavingsPlan: (r: Region, term: Term, pay: Payment) =>
    `${MUM}/computesavingsplan/USD/current/compute-savings-plan-ec2/${enc(TERM_LABEL[term])}/${enc(PAY_LABEL[pay])}/${enc(r.name)}/Linux/Shared/index.json`,
  s3: `${MUM}/s3/USD/current/s3.json`,
  dynamodb: `${MUM}/dynamodb/USD/current/dynamodb.json`,
  rds: (r: Region) => `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/${r.code}/index.csv`,
  vantage: 'https://instances.vantage.sh/instances.json',
}

const TERMS = ['1y', '3y'] as const
const PAYMENTS = ['noUpfront', 'partialUpfront', 'allUpfront'] as const
type Term = (typeof TERMS)[number]
type Payment = (typeof PAYMENTS)[number]
const TERM_LABEL: Record<Term, string> = { '1y': '1 year', '3y': '3 year' }
const TERM_HOURS: Record<Term, number> = { '1y': 8760, '3y': 3 * 8760 }
const PAY_LABEL: Record<Payment, string> = {
  noUpfront: 'No Upfront',
  partialUpfront: 'Partial Upfront',
  allUpfront: 'All Upfront',
}
/** Effective hourly rate of a commitment: hourly fee plus the upfront fee spread over the term (6 significant digits). */
const amortized = (hourly: number, upfront: number, term: Term) =>
  Number((hourly + upfront / TERM_HOURS[term]).toPrecision(6))
/** Commitment options in the order they appear in the generated tuples. */
const COMMITMENTS = TERMS.flatMap((t) => PAYMENTS.map((p) => [t, p] as const))

// ---------------------------------------------------------------------------------------------------------
// fetching

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const cacheDir = flag('--cache')
const only = flag('--only')?.split(',')
const want = (what: string) => !only || only.includes(what)
if (cacheDir) mkdirSync(cacheDir, { recursive: true })

const fetchBytes = async (u: string): Promise<Buffer> => {
  const cached = cacheDir ? join(cacheDir, createHash('sha256').update(u).digest('hex').slice(0, 16)) : undefined
  if (cached && existsSync(cached)) return readFileSync(cached)
  const res = await fetch(u)
  if (!res.ok) throw new Error(`GET ${u}: ${res.status} ${res.statusText}`)
  let buf = Buffer.from(await res.arrayBuffer())
  // meteredUnitMaps bodies are gzip even without Content-Encoding
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf)
  if (cached) writeFileSync(cached, buf)
  return buf
}
const fetchText = async (u: string) => (await fetchBytes(u)).toString('utf8')
const fetchJson = async <T>(u: string): Promise<T> => JSON.parse(await fetchText(u)) as T

interface UnitMap {
  manifest: { hawkFilePublicationDate?: string }
  regions: Record<string, Record<string, Record<string, string>>>
}

// ---------------------------------------------------------------------------------------------------------
// output helpers

/** local calendar date, YYYY-MM-DD */
const today = new Date().toLocaleDateString('sv-SE')
const OUT = new URL('../src/catalog/aws/', import.meta.url)

/** Numbers as plain decimals, trimmed of float noise. */
const num = (n: number | null | undefined): string => (n == null ? 'null' : String(Number(n.toPrecision(10))))
const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const sortKeys = <T>(o: Record<string, T>): [string, T][] =>
  Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
/** Natural sort for instance types: family, then size by vCPU. */
const byFamilyThen =
  (size: (id: string) => number) =>
  (a: string, b: string): number => {
    const [fa] = a.split('.')
    const [fb] = b.split('.')
    if (fa !== fb) return fa! < fb! ? -1 : 1
    return size(a) - size(b) || (a < b ? -1 : a > b ? 1 : 0)
  }

const header = (what: string, sources: string[], extra: string[] = []) =>
  [
    `// generated by scripts/fetch-aws-prices.ts (pnpm gen:aws) — do not edit`,
    `// ${what}`,
    `// retrieved ${today} from:`,
    ...sources.map((s) => `//   ${s}`),
    ...extra.map((s) => `// ${s}`),
    '',
  ].join('\n')

const write = (file: string, body: string) => {
  const path = new URL(file, OUT)
  writeFileSync(path, body)
  console.log(`wrote src/catalog/aws/${file} (${(body.length / 1024).toFixed(0)} KB)`)
}

// ---------------------------------------------------------------------------------------------------------
// EC2 specs from Vantage's ec2instances.info (https://github.com/vantage-sh/ec2instances.info, MIT)
//
// instances.json is ~300 MB, so it is streamed and each instance object is reduced to the few spec fields
// we keep. Its prices are not used: on-demand, RI and Savings Plan rates come from AWS's own files (a
// cross-check found Vantage's Savings Plan rates stale for older families such as c5).

const VANTAGE_LICENSE = [
  'Instance specs derived from ec2instances.info by Vantage (https://github.com/vantage-sh/ec2instances.info),',
  'used under the MIT License:',
  '  Copyright (c) 2013 Garret Heaton (powdahound.com)',
  '  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and',
  '  associated documentation files (the "Software"), to deal in the Software without restriction, including',
  '  without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  '  copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the',
  '  following conditions: The above copyright notice and this permission notice shall be included in all',
  '  copies or substantial portions of the Software.',
  '  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT',
  '  LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO',
  '  EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER',
  '  IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR',
  '  THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
]

interface Spec {
  arch?: string
  /** baseline / burst Gbps of the primary network card */
  networkGbps?: number
  networkBurstGbps?: number
  ebsMbps?: number
  ebsBurstMbps?: number
  ebsIops?: number
  ebsBurstIops?: number
  store?: { disks: number; diskGB: number; nvme: boolean; ssd: boolean; readIops?: number; writeIops?: number }
  maxPods?: number
}

const toNum = (s: string) => {
  if (!s.trim()) return undefined
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : undefined
}
/** positive finite numbers only (Vantage uses 0 or null for unknown) */
const pos = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined)

/** Stream the elements of a top-level JSON array without holding the whole document in memory. */
async function* jsonArrayItems(src: string): AsyncGenerator<unknown> {
  const res = await fetch(src)
  if (!res.ok || !res.body) throw new Error(`GET ${src}: ${res.status} ${res.statusText}`)
  const dec = new TextDecoder()
  let depth = 0
  let inStr = false
  let esc = false
  let pending = '' // text of the current element carried over from earlier chunks
  let inItem = false
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    const s = dec.decode(chunk, { stream: true })
    let start = inItem ? 0 : -1
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (inStr) {
        if (esc) esc = false
        else if (c === 92 /* \ */) esc = true
        else if (c === 34 /* " */) inStr = false
      } else if (c === 34) inStr = true
      else if (c === 123 /* { */ || c === 91 /* [ */) {
        if (depth === 1 && c === 123) {
          inItem = true
          start = i
        }
        depth++
      } else if (c === 125 /* } */ || c === 93 /* ] */) {
        depth--
        if (depth === 1 && inItem) {
          yield JSON.parse(pending + s.slice(start, i + 1))
          pending = ''
          inItem = false
          start = -1
        }
      }
    }
    if (inItem) pending += s.slice(start)
  }
}

const fetchSpecs = async (region: Region): Promise<Record<string, Spec>> => {
  const cached = cacheDir ? join(cacheDir, 'vantage-specs.json') : undefined
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8')) as Record<string, Spec>
  const specs: Record<string, Spec> = {}
  for await (const item of jsonArrayItems(url.vantage)) {
    const x = item as Record<string, any>
    // current generation, offered with Linux in the region
    if (x.generation !== 'current' || !x.pricing?.[region.code]?.linux?.ondemand) continue
    const st = x.storage as Record<string, any> | null
    const s: Spec = {
      ...(Array.isArray(x.arch) && x.arch.length ? { arch: [...x.arch].sort().join('/') } : {}),
      ...(pos(x.baseline_bandwidth_gbps)
        ? {
            networkGbps: x.baseline_bandwidth_gbps,
            networkBurstGbps: pos(x.burst_bandwidth_gbps) ?? x.baseline_bandwidth_gbps,
          }
        : {}),
      ...(pos(x.ebs_baseline_bandwidth)
        ? { ebsMbps: x.ebs_baseline_bandwidth, ebsBurstMbps: pos(x.ebs_max_bandwidth) ?? x.ebs_baseline_bandwidth }
        : {}),
      ...(pos(x.ebs_baseline_iops)
        ? { ebsIops: x.ebs_baseline_iops, ebsBurstIops: pos(x.ebs_iops) ?? x.ebs_baseline_iops }
        : {}),
      ...(st && pos(st.devices) && pos(st.size)
        ? {
            store: {
              disks: st.devices,
              diskGB: st.size_unit === 'TB' ? st.size * 1000 : st.size,
              nvme: !!st.nvme_ssd,
              ssd: !!st.ssd,
              ...(pos(st.storage_read_iops) ? { readIops: st.storage_read_iops } : {}),
              ...(pos(st.storage_write_iops) ? { writeIops: st.storage_write_iops } : {}),
            },
          }
        : {}),
      ...(pos(x.max_pods) ? { maxPods: x.max_pods } : {}),
    }
    specs[x.instance_type as string] = s
  }
  if (cached) writeFileSync(cached, JSON.stringify(specs))
  return specs
}

const writeSpecs = (specs: Record<string, Spec>) => {
  const ids = Object.keys(specs).sort(byFamilyThen(() => 0))
  const line = (id: string) => {
    const s = specs[id]!
    const f: string[] = []
    if (s.arch) f.push(`arch: ${str(s.arch)}`)
    if (s.networkGbps !== undefined) f.push(`network: [${num(s.networkGbps)}, ${num(s.networkBurstGbps)}]`)
    if (s.ebsMbps !== undefined) f.push(`ebsMbps: [${num(s.ebsMbps)}, ${num(s.ebsBurstMbps)}]`)
    if (s.ebsIops !== undefined) f.push(`ebsIops: [${num(s.ebsIops)}, ${num(s.ebsBurstIops)}]`)
    if (s.store) {
      const st = s.store
      const iops = [
        ...(st.readIops !== undefined ? [`readIops: ${num(st.readIops)}`] : []),
        ...(st.writeIops !== undefined ? [`writeIops: ${num(st.writeIops)}`] : []),
      ]
      f.push(
        `store: { ${[`disks: ${st.disks}`, `diskGB: ${num(st.diskGB)}`, `nvme: ${st.nvme}`, `ssd: ${st.ssd}`, ...iops].join(', ')} }`,
      )
    }
    if (s.maxPods !== undefined) f.push(`maxPods: ${s.maxPods}`)
    return `  ${str(id)}: { ${f.join(', ')} },`
  }
  const body =
    header(
      'EC2 instance specs (current generation, offered with Linux in us-east-1)',
      [url.vantage],
      [
        'network: [baseline, burst] Gbps of the primary network card (instances with several cards can reach more);',
        'ebsMbps: [baseline, max] Mbps; ebsIops: [baseline, max] (16 KiB I/O); store: local instance store volumes,',
        'readIops/writeIops are random IOPS summed over all volumes; maxPods: EKS max pods (VPC CNI default).',
        'A field is omitted when the source has no (or a zero) value for it.',
        '',
        ...VANTAGE_LICENSE,
      ],
    ) +
    `
export interface Ec2Spec {
  readonly arch?: string
  readonly network?: readonly [baseline: number, burst: number]
  readonly ebsMbps?: readonly [baseline: number, max: number]
  readonly ebsIops?: readonly [baseline: number, max: number]
  readonly store?: {
    readonly disks: number
    readonly diskGB: number
    readonly nvme: boolean
    readonly ssd: boolean
    readonly readIops?: number
    readonly writeIops?: number
  }
  readonly maxPods?: number
}

export const ec2SpecsRetrieved = ${str(today)}

export const ec2Specs: Readonly<Record<string, Ec2Spec>> = {
${ids.map(line).join('\n')}
}
`
  write('ec2-specs.gen.ts', body)
}

// ---------------------------------------------------------------------------------------------------------
// EC2 prices

const parseGiB = (s: string | undefined) => toNum((s ?? '').replace(/\s*GiB$/, ''))

const genEc2 = async (region: Region, specs: Record<string, Spec>) => {
  const od = await fetchJson<UnitMap>(url.ec2OnDemand(region))
  const rows: Record<
    string,
    { vcpu: number; memoryGiB: number; od: number; ri: (number | null)[]; sp: (number | null)[] }
  > = {}
  const notCurrent = new Set<string>()
  const noNetwork: string[] = []
  for (const v of Object.values(od.regions[region.name] ?? {})) {
    const id = v['Instance Type']!
    if (!specs[id]) {
      notCurrent.add(id.split('.')[0]!)
      continue
    }
    // capacity.network is required; a type without a baseline network figure is left out
    if (specs[id].networkGbps === undefined) {
      noNetwork.push(id)
      continue
    }
    const vcpu = toNum(v.vCPU ?? '')
    const memoryGiB = parseGiB(v.Memory)
    const price = toNum(v.price ?? '')
    if (!vcpu || !memoryGiB || !price) continue
    if (rows[id]) throw new Error(`ec2: duplicate on-demand row for ${id}`)
    rows[id] = { vcpu, memoryGiB, od: price, ri: COMMITMENTS.map(() => null), sp: COMMITMENTS.map(() => null) }
  }

  for (const [i, [term, pay]] of COMMITMENTS.entries()) {
    const ri = await fetchJson<UnitMap>(url.ec2Reserved(region, term, pay))
    for (const v of Object.values(ri.regions[region.name] ?? {})) {
      const row = rows[v['Instance Type']!]
      if (!row || v['Tenancy'] !== 'Shared' || v['Pre Installed S/W'] !== 'NA') continue
      const hourly = toNum(v.price ?? '') ?? 0
      const upfront = toNum(v['riupfront:PricePerUnit'] ?? '') ?? 0
      row.ri[i] = amortized(hourly, upfront, term)
    }
    const sp = await fetchJson<UnitMap>(url.ec2SavingsPlan(region, term, pay))
    for (const v of Object.values(sp.regions[region.name] ?? {})) {
      const row = rows[v['ec2:InstanceType']!]
      if (!row || v['ec2:Tenancy'] !== 'Shared' || v['ec2:PreInstalledSW'] !== 'NA') continue
      row.sp[i] = toNum(v.price ?? '') ?? null
    }
  }

  const ids = Object.keys(rows).sort(byFamilyThen((id) => rows[id]!.vcpu * 1e6 + rows[id]!.memoryGiB))
  const families = [...new Set(ids.map((id) => id.split('.')[0]!))].sort()
  const tuple = (xs: (number | null)[]) => (xs.every((x) => x === null) ? 'null' : `[${xs.map(num).join(', ')}]`)
  const body =
    header(
      `EC2 Linux shared-tenancy rates for ${region.code} (USD per instance-hour)`,
      [
        url.ec2OnDemand(region),
        url.ec2Reserved(region, '1y', 'noUpfront'),
        url.ec2SavingsPlan(region, '1y', 'noUpfront'),
      ],
      [
        '(and the other term/payment combinations of the last two)',
        `current-generation types only (per ec2instances.info); ${ids.length} types, ${families.length} families`,
        `previous-generation families, skipped: ${[...notCurrent].sort().join(' ') || '-'}`,
        `no baseline network figure, skipped: ${noNetwork.sort().join(' ') || '-'}`,
        'ri: standard reserved instances, sp: Compute Savings Plans; effective hourly rate (upfront fee amortized',
        'over the term), in the order of ec2CommitmentTerms; null when not offered',
      ],
    ) +
    `
export const ec2Region = ${str(region.code)}
export const ec2Retrieved = ${str(today)}

export const ec2CommitmentTerms = [${COMMITMENTS.map(([t, p]) => `[${str(t)}, ${str(p)}]`).join(', ')}] as const

type Rates = readonly [number | null, number | null, number | null, number | null, number | null, number | null]

export interface Ec2PriceRow {
  readonly vcpu: number
  readonly memoryGiB: number
  /** on-demand USD per hour */
  readonly od: number
  readonly ri: Rates | null
  readonly sp: Rates | null
}

export type Ec2InstanceId =
${ids.map((id) => `  | ${str(id)}`).join('\n')}

export const ec2Prices: Readonly<Record<Ec2InstanceId, Ec2PriceRow>> = {
${ids
  .map((id) => {
    const r = rows[id]!
    return `  ${str(id)}: { vcpu: ${r.vcpu}, memoryGiB: ${num(r.memoryGiB)}, od: ${num(r.od)}, ri: ${tuple(r.ri)}, sp: ${tuple(r.sp)} },`
  })
  .join('\n')}
}
`
  write('ec2.gen.ts', body)
  console.log(`  ec2: ${ids.length} types in ${families.length} families: ${families.join(' ')}`)
}

// ---------------------------------------------------------------------------------------------------------
// S3 and DynamoDB: named usage types from the metered unit maps

const genUnitMapRates = async (region: Region, file: string, name: string, src: string, what: string) => {
  const m = await fetchJson<UnitMap>(src)
  const rates: Record<string, { usd: number; rateCode: string }> = {}
  for (const [key, v] of Object.entries(m.regions[region.name] ?? {})) {
    // the maps list every rate twice: under a readable name and under an opaque regionless hash
    if (!key.includes(' ') || key === v.RegionlessRateCode) continue
    rates[key] = { usd: toNum(v.price ?? '') ?? 0, rateCode: v.rateCode ?? '' }
  }
  const entries = sortKeys(rates)
  const body =
    header(
      `${what} rates for ${region.code} (USD per usage unit), keyed by AWS usage-type name`,
      [src],
      [`published ${m.manifest.hawkFilePublicationDate ?? '?'}`],
    ) +
    `
export const ${name}Retrieved = ${str(today)}

export const ${name}Rates = {
${entries.map(([k, v]) => `  ${str(k)}: { usd: ${num(v.usd)}, rateCode: ${str(v.rateCode)} },`).join('\n')}
} as const
`
  write(file, body)
  console.log(`  ${name}: ${entries.length} rates`)
}

// ---------------------------------------------------------------------------------------------------------
// Aurora from the RDS bulk CSV

/** Minimal RFC 4180 CSV line parser (quoted fields, doubled quotes). */
const parseCsvLine = (line: string): string[] => {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

const AURORA_ENGINES = ['Aurora PostgreSQL', 'Aurora MySQL'] as const

const genAurora = async (region: Region, specs: Record<string, Spec>) => {
  const src = url.rds(region)
  const lines = (await fetchText(src)).split('\n')
  const cols = parseCsvLine(lines[5]!)
  const col = (name: string) => {
    const i = cols.indexOf(name)
    if (i < 0) throw new Error(`rds csv: no column '${name}'`)
    return i
  }
  const C = {
    sku: col('SKU'),
    term: col('TermType'),
    unit: col('Unit'),
    price: col('PricePerUnit'),
    lease: col('LeaseContractLength'),
    purchase: col('PurchaseOption'),
    offeringClass: col('OfferingClass'),
    productFamily: col('Product Family'),
    instance: col('Instance Type'),
    vcpu: col('vCPU'),
    memory: col('Memory'),
    storage: col('Storage'),
    engine: col('Database Engine'),
    deployment: col('Deployment Option'),
    usageType: col('usageType'),
  }
  type Inst = { sku: string; vcpu: number; memoryGiB: number; od: number; ri: (number | null)[] }
  const inst: Record<string, Record<string, { standard?: Inst; ioOptimized?: Inst }>> = {}
  const other: Record<string, Record<string, { usd: number; sku: string }>> = {}
  const reserved: string[][] = []
  const anyEngine: Record<string, { usd: number; sku: string }> = {}
  const STORAGE_USAGE: Record<string, string> = {
    'Aurora:StorageUsage': 'storage',
    'Aurora:IO-OptimizedStorageUsage': 'ioOptimizedStorage',
    'Aurora:StorageIOUsage': 'io',
  }
  for (const line of lines.slice(6)) {
    if (!line.includes('Aurora')) continue
    const r = parseCsvLine(line)
    const engine = r[C.engine]!
    // storage and I/O rows for Aurora MySQL are published under the engine-neutral 'Any'
    if (engine === 'Any' && r[C.term] === 'OnDemand') {
      const key = STORAGE_USAGE[r[C.usageType]!]
      if (key) anyEngine[key] ??= { usd: toNum(r[C.price]!) ?? 0, sku: r[C.sku]! }
      continue
    }
    if (!(AURORA_ENGINES as readonly string[]).includes(engine)) continue
    if (r[C.term] === 'Reserved') {
      reserved.push(r)
      continue
    }
    if (r[C.term] !== 'OnDemand') continue
    const usd = toNum(r[C.price]!) ?? 0
    if (r[C.productFamily] === 'Database Instance') {
      if (r[C.deployment] !== 'Single-AZ' || r[C.unit] !== 'Hrs') continue
      const usage = r[C.usageType]!
      const kind = /^InstanceUsage:/.test(usage)
        ? 'standard'
        : /^InstanceUsageIOOptimized:/.test(usage)
          ? 'ioOptimized'
          : undefined
      if (!kind) continue
      const e = ((inst[engine] ??= {})[r[C.instance]!] ??= {})
      if (e[kind]) throw new Error(`rds: duplicate ${engine} ${r[C.instance]} ${kind}`)
      e[kind] = {
        sku: r[C.sku]!,
        vcpu: toNum(r[C.vcpu]!) ?? 0,
        memoryGiB: parseGiB(r[C.memory]) ?? 0,
        od: usd,
        ri: COMMITMENTS.map(() => null),
      }
    } else {
      const key = STORAGE_USAGE[r[C.usageType]!]
      if (key) (other[engine] ??= {})[key] = { usd, sku: r[C.sku]! }
    }
  }
  for (const e of AURORA_ENGINES) for (const [k, v] of Object.entries(anyEngine)) (other[e] ??= {})[k] ??= v
  // Reserved: hourly + upfront rows share SKU and term; standard offering class only.
  const bySku = new Map<string, Inst>()
  for (const e of Object.values(inst))
    for (const v of Object.values(e)) if (v.standard) bySku.set(v.standard.sku, v.standard)
  const acc = new Map<string, { hourly: number; upfront: number }>()
  for (const r of reserved) {
    if (r[C.offeringClass] !== 'standard' || !bySku.has(r[C.sku]!)) continue
    const k = `${r[C.sku]}|${r[C.lease]}|${r[C.purchase]}`
    const a = acc.get(k) ?? { hourly: 0, upfront: 0 }
    if (r[C.unit] === 'Hrs') a.hourly = toNum(r[C.price]!) ?? 0
    else if (r[C.unit] === 'Quantity') a.upfront = toNum(r[C.price]!) ?? 0
    acc.set(k, a)
  }
  for (const [k, a] of acc) {
    const [sku, lease, purchase] = k.split('|')
    const term = lease === '1yr' ? '1y' : lease === '3yr' ? '3y' : undefined
    const pay = PAYMENTS.find((p) => PAY_LABEL[p] === purchase)
    if (!term || !pay) continue
    const i = COMMITMENTS.findIndex(([t, p]) => t === term && p === pay)
    bySku.get(sku!)!.ri[i] = amortized(a.hourly, a.upfront, term)
  }

  const tuple = (xs: (number | null)[]) => (xs.every((x) => x === null) ? 'null' : `[${xs.map(num).join(', ')}]`)
  const engineKey = (e: string) => (e === 'Aurora PostgreSQL' ? 'postgresql' : 'mysql')
  let count = 0
  const noSpecs = new Set<string>()
  const engineBlock = (engine: string) => {
    const e = inst[engine] ?? {}
    const ids = Object.keys(e)
      .filter((id) => e[id]!.standard)
      .filter((id) => {
        // capacity comes from the matching EC2 type's specs (db.r7g.large → r7g.large)
        const ok = specs[id.replace(/^db\./, '')]?.networkGbps !== undefined
        if (!ok) noSpecs.add(id)
        return ok
      })
      .sort(byFamilyThen((id) => e[id]!.standard!.vcpu * 1e6 + e[id]!.standard!.memoryGiB))
    count += ids.length
    return ids
      .map((id) => {
        const { standard: s, ioOptimized: io } = e[id]!
        return `    ${str(id)}: { vcpu: ${s!.vcpu}, memoryGiB: ${num(s!.memoryGiB)}, od: ${num(s!.od)}, ioOptimized: ${num(io?.od)}, ri: ${tuple(s!.ri)} },`
      })
      .join('\n')
  }
  const rateBlock = (engine: string) =>
    sortKeys(other[engine] ?? {})
      .map(([k, v]) => `    ${k}: ${num(v.usd)},`)
      .join('\n')
  const blocks = AURORA_ENGINES.map((e) => `  ${engineKey(e)}: {\n${engineBlock(e)}\n  },`).join('\n')
  const body =
    header(
      `Aurora (provisioned, Single-AZ instance rows) rates for ${region.code}`,
      [src],
      [
        'od: on-demand USD per instance-hour (Aurora Standard); ioOptimized: the same under Aurora I/O-Optimized',
        'ri: standard reserved instances (Aurora Standard), effective hourly rate with the upfront fee amortized,',
        'in the order of auroraCommitmentTerms; null when not offered',
        'storage/ioOptimizedStorage: USD per GB-month; io: USD per I/O request',
        'instance classes without a current-generation EC2 counterpart with a baseline network figure, skipped:',
        `  ${[...noSpecs].sort().join(' ') || '-'}`,
      ],
    ) +
    `
export const auroraRegion = ${str(region.code)}
export const auroraRetrieved = ${str(today)}

export const auroraCommitmentTerms = [${COMMITMENTS.map(([t, p]) => `[${str(t)}, ${str(p)}]`).join(', ')}] as const

type Rates = readonly [number | null, number | null, number | null, number | null, number | null, number | null]

export interface AuroraPriceRow {
  readonly vcpu: number
  readonly memoryGiB: number
  readonly od: number
  readonly ioOptimized: number | null
  readonly ri: Rates | null
}

export const auroraPrices = {
${blocks}
} as const satisfies Record<string, Record<string, AuroraPriceRow>>

export const auroraStorageRates = {
${AURORA_ENGINES.map((e) => `  ${engineKey(e)}: {\n${rateBlock(e)}\n  },`).join('\n')}
} as const
`
  write('aurora.gen.ts', body)
  console.log(`  aurora: ${count} instance rows`)
}

// ---------------------------------------------------------------------------------------------------------

const region = REGIONS[0]
const specs = want('ec2') || want('aurora') ? await fetchSpecs(region) : undefined
if (want('ec2')) {
  writeSpecs(specs!)
  console.log(`  specs: ${Object.keys(specs!).length} types`)
  await genEc2(region, specs!)
}
if (want('s3')) await genUnitMapRates(region, 's3.gen.ts', 's3', url.s3, 'S3')
if (want('dynamodb')) await genUnitMapRates(region, 'dynamodb.gen.ts', 'dynamodb', url.dynamodb, 'DynamoDB')
if (want('aurora')) await genAurora(region, specs!)
