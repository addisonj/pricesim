// Tiny synthetic catalog and helpers for the engine unit tests. Everything uses round numbers so the
// expected values can be computed by hand; nothing here depends on the AWS catalog.
//
// Conventions used in the hand computations:
//   M = MONTH_SECONDS = 730 h × 3600 s = 2,628,000 s (the default workload period is one billing month)
//   H = 730 (hours in the billing month)
import {
  dimension,
  MONTH_SECONDS,
  pricing,
  q,
  series,
  u,
  type CostNode,
  type InstanceType,
  type PoolReport,
  type Result,
} from '../../src/index.ts'

export const M = MONTH_SECONDS
export const H = 730

export const perSecond = u.req.div(u.s)
/** constant request rate in req/s */
export const rps = (n: number) => series.constant(q(n, perSecond))
/** per-request CPU in millicore·seconds (100 millicore·s = 0.1 core busy for one second) */
export const cpuS = u.millicore.mul(u.s)

/** us-east-1: region multiplier 1, no discounts */
export const list = pricing()

/**
 * An instance type with round capacities, billed $`usdPerHour` per instance-hour.
 * Defaults: 1 vCPU (1000 millicore), 1 GB memory, 8 Mbps (= 1e6 byte/s) network, $1/h; no EBS limits and no
 * local NVMe unless given (`ebsBytesPerSecond`, `ebsIops` in op/s, `nvmeGB`).
 */
export const instanceType = (
  id: string,
  opts: {
    millicores?: number
    memoryGB?: number
    bytesPerSecond?: number
    usdPerHour?: number
    ebsBytesPerSecond?: number
    ebsIops?: number
    nvmeGB?: number
  } = {},
): InstanceType => ({
  id,
  capacity: {
    cpu: q(opts.millicores ?? 1000, u.millicore),
    memory: q(opts.memoryGB ?? 1, u.GB),
    network: q(opts.bytesPerSecond ?? 1e6, u.byte.div(u.s)),
    ...(opts.ebsBytesPerSecond !== undefined ? { ebsBandwidth: q(opts.ebsBytesPerSecond, u.byte.div(u.s)) } : {}),
    ...(opts.ebsIops !== undefined ? { ebsIops: q(opts.ebsIops, u.op.div(u.s)) } : {}),
    ...(opts.nvmeGB !== undefined ? { nvme: { bytes: q(opts.nvmeGB, u.GB) } } : {}),
  },
  price: dimension(`t.vm.${id}.hours`, u.hour, opts.usdPerHour ?? 1, { family: 't.compute' }),
})

/** $1 per million requests */
export const requestDim = (id: string, usdPerReq = 1e-6) => dimension(id, u.req, usdPerReq)

/** $0.10 per GB-month */
export const storageDim = (id: string, usdPerGBMonth = 0.1) => dimension(id, u.GB.mul(u.month), usdPerGBMonth)

/** $0.01 per GB transferred */
export const transferDim = (id = 't.transfer.inter-az') => dimension(id, u.GB, 0.01)

export const dimOf = (r: Result, id: string) => {
  const d = r.dimensions.find((x) => x.id === id)
  if (!d) throw new Error(`no dimension '${id}' in [${r.dimensions.map((x) => x.id).join(', ')}]`)
  return d
}

export const poolOf = (r: Result, name: string): PoolReport => {
  const p = r.pools.find((x) => x.name === name)
  if (!p) throw new Error(`no pool '${name}' in [${r.pools.map((x) => x.name).join(', ')}]`)
  return p
}

/** Walk the cost tree by child names. */
export const nodeAt = (root: CostNode, path: readonly string[]): CostNode => {
  let cur = root
  for (const name of path) {
    const next = cur.children?.find((c) => c.name === name)
    if (!next) {
      const names = (cur.children ?? []).map((c) => c.name).join(', ')
      throw new Error(`no node '${name}' under '${cur.name}' (children: ${names})`)
    }
    cur = next
  }
  return cur
}

/** All root-to-leaf paths as 'a/b/c' strings (kind-free), for structural assertions. */
export const leafPaths = (n: CostNode, prefix: readonly string[] = []): string[] =>
  n.children?.length ? n.children.flatMap((c) => leafPaths(c, [...prefix, c.name])) : [prefix.join('/')]
