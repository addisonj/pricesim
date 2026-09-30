// Capacity providers (DESIGN.md §5.3, §6.2, §6.4): instance types, instance pools (e.g. EC2, Aurora
// instances), Kubernetes node pools, and pod groups that run on node pools.
import type { Same } from '../core/dim.ts'
import type { Bindings, Expr } from '../core/expr.ts'
import type { BillingDimension } from '../pricing/dimension.ts'
import { doc, docs } from '../docs/registry.ts'

export type CpuSeconds = { millicore: 1; s: 1 }
/**
 * Capacity resources a sink can be sized on. Rate resources are demanded per request and sized against a
 * per-second capacity (cpu: millicore, network/ebsBandwidth: byte/s, ebsIops: op/s); level resources are held
 * (driven by gauges) and sized against an amount (memory, disk: bytes).
 */
export type Resource = 'cpu' | 'memory' | 'network' | 'ebsBandwidth' | 'ebsIops' | 'disk'
export const RESOURCES: readonly Resource[] = ['cpu', 'memory', 'network', 'ebsBandwidth', 'ebsIops', 'disk']
/**
 * A built-in resource, or a custom one a pool declares itself (e.g. 'streams' or 'partitions' — capacity set
 * by software configuration rather than by the instance type).
 */
export type ResourceName = Resource | (string & {})
/** resources demanded as a level (gaugeUse), not per request */
export const LEVEL_RESOURCES: ReadonlySet<Resource> = new Set(['memory', 'disk'])

docs([
  {
    name: 'RESOURCES',
    kind: 'const',
    module: 'pricesim/model',
    summary: "The built-in capacity resources: `['cpu', 'memory', 'network', 'ebsBandwidth', 'ebsIops', 'disk']`.",
    signature: 'const RESOURCES: readonly Resource[]',
    guidance: `
- Custom capacity (declared with \`service({ capacity })\`) can't reuse these names; declaring one throws.`,
    seeAlso: ['Resource', 'LEVEL_RESOURCES', 'Sink'],
    guide: 'capacity',
  },
  {
    name: 'LEVEL_RESOURCES',
    kind: 'const',
    module: 'pricesim/model',
    summary: 'The built-in resources held as a level rather than demanded per request: `memory` and `disk`.',
    signature: 'const LEVEL_RESOURCES: ReadonlySet<Resource>',
    seeAlso: ['RESOURCES', 'Sink'],
    guide: 'capacity',
  },
  {
    name: 'Resource',
    kind: 'type',
    module: 'pricesim/model',
    summary: 'A built-in capacity resource a pool can be sized on.',
    signature: "type Resource = 'cpu' | 'memory' | 'network' | 'ebsBandwidth' | 'ebsIops' | 'disk'",
    guidance: `
- **Rates**, demanded per request and sized against a per-second capacity: \`cpu\` (millicore), \`network\` and \`ebsBandwidth\` (byte/s), \`ebsIops\` (op/s).
- **Levels**, held (from gauges, in \`gaugeUse\`) and sized against an amount: \`memory\`, \`disk\` (bytes).
- \`ResourceName\` is a \`Resource\` or the name of a custom resource a service declares with \`capacity\`.`,
    seeAlso: ['RESOURCES', 'Sink', 'service'],
    guide: 'capacity',
  },
])

export interface InstanceType {
  readonly id: string
  readonly capacity: {
    readonly cpu: Expr<{ millicore: 1 }>
    readonly memory: Expr<{ byte: 1 }>
    /** baseline network bandwidth (not "up to") */
    readonly network: Expr<{ byte: 1; s: -1 }>
    /** baseline EBS bandwidth (not burst); absent when unknown */
    readonly ebsBandwidth?: Expr<{ byte: 1; s: -1 }>
    /** baseline EBS IOPS (16 KiB I/O, not burst); absent when unknown */
    readonly ebsIops?: Expr<{ op: 1; s: -1 }>
    /** local NVMe instance store, summed over all volumes; absent when the type has none */
    readonly nvme?: {
      readonly bytes: Expr<{ byte: 1 }>
      /** 100% random read IOPS, all volumes */
      readonly readIops?: Expr<{ op: 1; s: -1 }>
      /** random write IOPS, all volumes */
      readonly writeIops?: Expr<{ op: 1; s: -1 }>
    }
  }
  /** billed per instance-hour */
  readonly price: BillingDimension<{ s: 1 }>
}

doc({
  name: 'InstanceType',
  kind: 'type',
  module: 'pricesim/model',
  summary: 'What one instance (or node) provides and what it costs per hour.',
  signature: `interface InstanceType {
  id: string
  capacity: {
    cpu: Expr<millicore>; memory: Expr<byte>; network: Expr<byte/s>
    ebsBandwidth?: Expr<byte/s>; ebsIops?: Expr<op/s>
    nvme?: { bytes: Expr<byte>; readIops?: Expr<op/s>; writeIops?: Expr<op/s> }
  }
  price: BillingDimension<s>
}`,
  guidance: `
- Take these from the catalog (\`ec2['c7g.2xlarge']\`, \`auroraInstances[…]\`) rather than writing them; write one only for hardware the catalog lacks.
- \`network\` is the baseline bandwidth, not the "up to" burst figure. \`ebsBandwidth\` and \`ebsIops\` are baseline EBS limits; leave them out when unknown.
- \`nvme.bytes\` (local instance store, all volumes) counts as \`disk\` capacity. \`nvme.readIops\`/\`writeIops\` are informational: no pool is sized on them.
- A pool is sized on, and accepts demand for, only the resources the type or its volumes provide (plus declared custom ones); demand on a missing one throws at evaluation.
- \`price\` must be a dimension billed per unit of time (usually \`u.hour\`); one unit is billed per instance-second held.`,
  examples: [
    `import { dimension, q, u } from 'pricesim'
import type { InstanceType } from 'pricesim/model'

const vm: InstanceType = {
  id: 'my-vm',
  capacity: { cpu: q(8, u.vCPU), memory: q(32, u.GiB), network: q(10, u.Gbps) },
  price: dimension('example.vm.hours', u.hour, 0.4),
}`,
  ],
  seeAlso: ['instancePool', 'nodePool', 'ec2'],
  guide: 'capacity',
})

/** A demand placed on a capacity sink, per request (rate-driven) or as a level (gauge-driven). */
export interface PoolUse {
  readonly sink: Sink
  readonly resource: ResourceName
  /** per request: cpu in millicore·s, network/ebsBandwidth in bytes, ebsIops in ops; level: memory/disk in bytes */
  readonly amount: Expr<any>
  readonly level: boolean
}

doc({
  name: 'PoolUse',
  kind: 'type',
  module: 'pricesim/model',
  summary:
    'A demand on a pool or pod group, as returned by `pool.cpu(…)`, `.memory(…)`, `.use(…)` and the other `Sink` methods.',
  signature: 'interface PoolUse { sink: Sink; resource: ResourceName; amount: Expr; level: boolean }',
  guidance: `
- Build it with the \`Sink\` methods, not by hand. Rate demands (\`level: false\`) go in a request's \`use\`; level demands go in the node's \`gaugeUse\`.`,
  seeAlso: ['Sink', 'request', 'service'],
  guide: 'capacity',
})

/** Something requests and gauges can place demand on. */
export abstract class Sink {
  abstract readonly kind: 'instances' | 'pods'
  constructor(readonly name: string) {}

  /** custom capacity per instance (per pod), declared by the service(s) running on this sink */
  private readonly derived: Record<string, { readonly capacity: Expr<any>; readonly owner: string }> = {}

  /** per-instance (per-pod) capacity of a custom resource declared on this sink, if any */
  customCapacity(resource: string): Expr<any> | undefined {
    return this.derived[resource]?.capacity
  }

  /** names of the custom resources declared on this sink */
  customResources(): string[] {
    return Object.keys(this.derived)
  }

  /**
   * Declare custom capacity per instance (per pod) on this sink — done by `service({ capacity })`, which derives
   * it from the sink's hardware. A resource can only be declared once (by one service).
   */
  declareCapacity(owner: string, capacities: Readonly<Record<string, Expr<any>>>): void {
    for (const [name, capacity] of Object.entries(capacities)) {
      if ((RESOURCES as readonly string[]).includes(name)) {
        throw new Error(
          `${owner}: '${name}' is a built-in resource of '${this.name}'; custom capacity needs another name`,
        )
      }
      const prev = this.derived[name]
      if (prev && prev.owner !== owner) {
        throw new Error(`${owner}: '${this.name}' already has capacity '${name}' declared by ${prev.owner}`)
      }
      this.derived[name] = { capacity, owner }
    }
  }

  /** the per-instance (per-pod) hardware a service derives custom capacity from */
  abstract hardware(): Hardware

  /**
   * Demand on a custom resource per request, e.g. `pool.use('appends', q(1, u.op))`. A service must declare its
   * capacity per instance (per pod) as a rate — the per-request unit per second — with `capacity`.
   */
  use<E>(resource: string, perRequest: Expr<E>): PoolUse {
    return { sink: this, resource, amount: perRequest, level: false }
  }
  /**
   * A custom resource held as a level (in gaugeUse), e.g. `pool.hold('streams', g.streams)`. A service must
   * declare its capacity per instance (per pod) in the same unit, with `capacity`.
   */
  hold<E>(resource: string, level: Expr<E>): PoolUse {
    return { sink: this, resource, amount: level, level: true }
  }

  /** CPU consumed per request, e.g. `q(40, cpuMs)` */
  cpu<E>(perRequest: Expr<E> & Same<E, CpuSeconds>): PoolUse {
    return { sink: this, resource: 'cpu', amount: perRequest, level: false }
  }
  /** Network bytes moved per request */
  network<E>(perRequest: Expr<E> & Same<E, { byte: 1 }>): PoolUse {
    return { sink: this, resource: 'network', amount: perRequest, level: false }
  }
  /** Memory held as a level (driven by gauges) */
  memory<E>(level: Expr<E> & Same<E, { byte: 1 }>): PoolUse {
    return { sink: this, resource: 'memory', amount: level, level: true }
  }
  /** EBS bytes read or written per request (sized against the instance's EBS bandwidth) */
  ebsBandwidth<E>(perRequest: Expr<E> & Same<E, { byte: 1 }>): PoolUse {
    return { sink: this, resource: 'ebsBandwidth', amount: perRequest, level: false }
  }
  /** EBS I/O operations per request (sized against the instance's EBS IOPS) */
  ebsIops<E>(perRequest: Expr<E> & Same<E, { op: 1 }>): PoolUse {
    return { sink: this, resource: 'ebsIops', amount: perRequest, level: false }
  }
  /** Disk space held as a level (driven by gauges): local NVMe plus any attached volume */
  disk<E>(level: Expr<E> & Same<E, { byte: 1 }>): PoolUse {
    return { sink: this, resource: 'disk', amount: level, level: true }
  }
}

doc({
  name: 'Sink',
  kind: 'class',
  module: 'pricesim/model',
  summary: 'Base class of `InstancePool` and `PodGroup`: something requests and gauges place demand on.',
  signature: `abstract class Sink {
  readonly name: string
  readonly kind: 'instances' | 'pods'
  cpu(perRequest: Expr<millicore·s>): PoolUse
  network(perRequest: Expr<byte>): PoolUse
  ebsBandwidth(perRequest: Expr<byte>): PoolUse
  ebsIops(perRequest: Expr<op>): PoolUse
  memory(level: Expr<byte>): PoolUse
  disk(level: Expr<byte>): PoolUse
  use(resource: string, perRequest: Expr): PoolUse
  hold(resource: string, level: Expr): PoolUse
}`,
  returns: "Each method returns a `PoolUse` to put in a request body's `use` (rates) or in `gaugeUse` (levels).",
  guidance: `
- **Per request** (in a request's \`use\`): \`cpu\` takes CPU time per request (millicore·s; define \`const coreMs = u.vCPU.mul(u.ms)\`, since \`u.millicore.mul(u.ms)\` is 1000× smaller); \`network\` bytes moved per request; \`ebsBandwidth\` EBS bytes read or written per request; \`ebsIops\` EBS I/O operations per request. Demand is the amount × the request rate, per time step.
- **Levels** (in \`gaugeUse\`, driven by gauges): \`memory\` and \`disk\`, in bytes. A level demand in a request's \`use\` throws at evaluation.
- **Custom resources:** \`use(name, perRequest)\` is a rate; the service must declare the capacity with \`capacity\` in the per-request unit per second (e.g. \`op\` per request against \`op/s\`). \`hold(name, level)\` is a level; the capacity is in the same unit as the level. An undeclared name, or mismatched units, throws at evaluation.
- Demand on a resource the pool has no capacity for (e.g. \`ebsIops\` on an instance type with no EBS limit and no volumes, or \`disk\` on pods) throws at evaluation.
- On pods, only \`cpu\`, \`memory\`, \`network\` (when the pod request declares it) and custom resources are available.`,
  seeAlso: ['instancePool', 'pods', 'PoolUse', 'service'],
  guide: 'capacity',
})

export interface InstancePoolSpec {
  readonly instance: InstanceType
  /** minimum instances (e.g. 3 for HA, 2 for writer + reader) */
  readonly min: number
  /** target utilization of every resource at peak */
  readonly loadFactor: number
  readonly azs: number
  /** block-storage volumes attached to every instance (e.g. 4 × EBS gp3), billed per instance */
  readonly volumes?: readonly VolumeSpec[]
}

/**
 * A pool of whole instances sized on every resource its instance type declares (EC2 fleet, Aurora instances,
 * …); the resource needing the most instances is the binding one.
 */
export class InstancePool extends Sink {
  readonly kind = 'instances' as const
  constructor(
    name: string,
    readonly spec: InstancePoolSpec,
  ) {
    super(name)
  }
  hardware(): Hardware {
    return hardwareOf(this.spec.instance, this.spec.volumes)
  }
}

doc({
  name: 'InstancePool',
  kind: 'class',
  module: 'pricesim/model',
  summary: 'A pool of whole instances; create one with `instancePool(name, spec)`.',
  signature: 'class InstancePool extends Sink { readonly kind: "instances"; readonly spec: InstancePoolSpec }',
  seeAlso: ['instancePool', 'Sink'],
  guide: 'capacity',
})

export const instancePool = (name: string, spec: InstancePoolSpec): InstancePool => new InstancePool(name, spec)

doc({
  name: 'instancePool',
  kind: 'function',
  module: 'pricesim/model',
  summary:
    'A pool of whole instances (an EC2 fleet, Aurora instances, …), sized at peak on every resource its instance type has.',
  signature: 'instancePool(name: string, spec: InstancePoolSpec): InstancePool',
  params: [
    {
      name: 'name',
      type: 'string',
      doc: 'Unique across the model: `pricesim capacity --fix <name>=n` and the pools report use it.',
    },
    {
      name: 'spec.instance',
      type: 'InstanceType',
      doc: "What one instance is and costs, e.g. `ec2['c7g.2xlarge']` from `pricesim/aws`.",
    },
    {
      name: 'spec.min',
      type: 'number',
      doc: 'Minimum instances, provisioned even with no traffic (3 for a quorum, 2 for writer + reader).',
    },
    {
      name: 'spec.loadFactor',
      type: 'number',
      doc: 'Target utilization of every resource at peak, 0–1 (0.7 leaves 30% headroom).',
    },
    {
      name: 'spec.azs',
      type: 'number',
      doc: 'Availability zones the pool spans. Descriptive only: sizing does not round to a multiple of it, and cross-AZ traffic comes from `edge(…)` in request bodies.',
    },
    {
      name: 'spec.volumes',
      type: 'VolumeSpec[]',
      optional: true,
      doc: 'Block volumes on every instance, e.g. `[{ type: gp3, size: q(1, u.TiB) }]`; billed per instance, and they add disk, EBS bandwidth and IOPS.',
    },
  ],
  returns:
    "An `InstancePool`. Pass it in a service's `pools` and demand capacity from it in request handlers: `pool.cpu(…)`, `.network(…)`, `.ebsBandwidth(…)`, `.ebsIops(…)` per request; `.memory(…)`, `.disk(…)` as levels in `gaugeUse`; `.use(name, …)` / `.hold(name, …)` for custom resources.",
  guidance: `
- **Sizing:** at peak, each resource needs \`ceil(demand / (capacity × loadFactor))\` instances; the pool takes the largest (the *binding* resource, shown in results), then at least \`min\`.
- **Only declared demand counts.** A request that doesn't call \`pool.cpu(…)\` uses no CPU. Model the resource that actually binds (often network or disk for data systems, not CPU).
- **Idle cost:** capacity above what requests use is reported as idle and, in tenant runs, shared out in proportion to used cost.
- **Instances vs pods:** use an instance pool for software that owns whole machines (databases, brokers); use \`nodePool\` + \`pods\` for services packed onto a shared Kubernetes cluster.
- Volume size is fixed per pool: when disk binds, the pool adds instances rather than growing volumes.`,
  examples: [
    `import { q, u } from 'pricesim'
import { instancePool, request, service } from 'pricesim/model'
import { ec2, gp3 } from 'pricesim/aws'

const brokers = instancePool('brokers', {
  instance: ec2['c7g.2xlarge'],
  min: 3,
  loadFactor: 0.7,
  azs: 3,
  volumes: [{ type: gp3, size: q(1, u.TiB) }],
})

const coreMs = u.vCPU.mul(u.ms)
export const log = service('log', {
  pools: { brokers },
  requests: ({ pools }) => ({
    // each append is written to 3 replicas and costs 0.2 core·ms
    append: request({ bytes: u.byte }, (r) => ({
      use: [pools.brokers.network(r.bytes.mul(3)), pools.brokers.cpu(q(0.2, coreMs))],
    })),
  }),
})`,
  ],
  seeAlso: ['nodePool', 'pods', 'service', 'ec2', 'gp3'],
  guide: 'capacity',
})

export interface NodePoolSpec {
  readonly instance: InstanceType
  readonly min: number
  readonly azs: number
  /** per-node capacity reserved for the system (kubelet, daemonsets) */
  readonly reserved: { readonly cpu: Expr<{ millicore: 1 }>; readonly memory: Expr<{ byte: 1 }> }
  readonly maxPods: number
  /** fraction of allocatable capacity that pods can actually be packed into */
  readonly packingEfficiency: number
  /** block-storage volumes attached to every node (e.g. an EBS gp3 root/data volume), billed per node */
  readonly volumes?: readonly VolumeSpec[]
}

/** Kubernetes node pool: shared cluster infrastructure, sized from the pod groups placed on it. */
export class NodePool {
  constructor(
    readonly name: string,
    readonly spec: NodePoolSpec,
  ) {}
}

doc({
  name: 'NodePool',
  kind: 'class',
  module: 'pricesim/model',
  summary:
    'A Kubernetes node pool; create one with `nodePool(name, spec)`. Not a `Sink`: demand goes on the pod groups placed on it.',
  signature: 'class NodePool { readonly name: string; readonly spec: NodePoolSpec }',
  seeAlso: ['nodePool', 'pods'],
  guide: 'capacity',
})

export const nodePool = (name: string, spec: NodePoolSpec): NodePool => new NodePool(name, spec)

doc({
  name: 'nodePool',
  kind: 'function',
  module: 'pricesim/model',
  summary: 'A Kubernetes node pool shared by pod groups, sized from the pod requests placed on it.',
  signature: 'nodePool(name: string, spec: NodePoolSpec): NodePool',
  params: [
    { name: 'name', type: 'string', doc: 'Unique across the model; the pools report uses it.' },
    { name: 'spec.instance', type: 'InstanceType', doc: "The node type, e.g. `ec2['m7g.xlarge']`." },
    { name: 'spec.min', type: 'number', doc: 'Minimum nodes, once any pod group is placed on the pool.' },
    {
      name: 'spec.azs',
      type: 'number',
      doc: 'Availability zones the pool spans. Descriptive only: sizing does not use it.',
    },
    {
      name: 'spec.reserved',
      type: '{ cpu: Expr<millicore>; memory: Expr<byte> }',
      doc: "Per-node capacity kept for the system (kubelet, daemonsets); pods can't use it.",
    },
    { name: 'spec.maxPods', type: 'number', doc: 'Most pods per node.' },
    {
      name: 'spec.packingEfficiency',
      type: 'number',
      doc: 'Fraction (0–1) of the capacity left after `reserved` that pod requests can actually fill.',
    },
    {
      name: 'spec.volumes',
      type: 'VolumeSpec[]',
      optional: true,
      doc: "Block volumes on every node, e.g. a gp3 root volume. Billed per node; pods can't demand disk or EBS, so they only add cost.",
    },
  ],
  returns: "A `NodePool`. Pass it as `on` to `pods(…)`; it is not listed in a service's `pools` itself.",
  guidance: `
- **Sizing:** nodes = max(\`min\`, ceil(total pods / \`maxPods\`), and per resource ceil(Σ replicas × pod request / ((node capacity − reserved) × \`packingEfficiency\`))). Resources are cpu and memory, plus network when any pod group on the pool requests network (no network is reserved).
- Sized from pod **requests** (replicas × request), not from actual use. Usage inside the requests is attributed to requests; the rest shows as idle: \`pod headroom: <group>\`, \`system overhead\` (the reservation) and \`node slack\`.
- A node pool with no pod groups in the model is not provisioned at all, whatever its \`min\`.
- Custom resources declared on pod groups size replicas only; they don't size nodes.
- The pool bills to the account of the first pod group placed on it, so keep pod groups on one node pool in one account.`,
  examples: [
    `import { q, u } from 'pricesim'
import { nodePool } from 'pricesim/model'
import { ec2 } from 'pricesim/aws'

// m7g.xlarge: 4 vCPU, 16 GiB; 400 millicores and 1.5 GiB per node for kubelet and daemonsets
export const general = nodePool('general', {
  instance: ec2['m7g.xlarge'],
  min: 3,
  azs: 3,
  reserved: { cpu: q(400, u.millicore), memory: q(1.5, u.GiB) },
  maxPods: 58,
  packingEfficiency: 0.85,
})`,
  ],
  seeAlso: ['pods', 'instancePool', 'ec2', 'capacity'],
  guide: 'capacity',
})

export interface PodGroupSpec {
  readonly on: NodePool
  /**
   * Per-pod resource requests (limits are assumed equal to requests). `network` (byte/s) is optional: when
   * declared, network demand sizes replicas and the node pool checks it against node bandwidth; without it,
   * network demand on the pods is an error.
   */
  readonly request: {
    readonly cpu: Expr<{ millicore: 1 }>
    readonly memory: Expr<{ byte: 1 }>
    readonly network?: Expr<{ byte: 1; s: -1 }>
  }
  readonly minReplicas: number
  /** target utilization of the pod's requested resources at peak */
  readonly targetUtilization: number
}

/** A Deployment-like group of pods owned by a service, running on a node pool. */
export class PodGroup extends Sink {
  readonly kind = 'pods' as const
  constructor(
    name: string,
    readonly spec: PodGroupSpec,
  ) {
    super(name)
  }
  hardware(): Hardware {
    const r = this.spec.request
    return { cpu: r.cpu, memory: r.memory, ...(r.network ? { network: r.network } : {}) }
  }
}

doc({
  name: 'PodGroup',
  kind: 'class',
  module: 'pricesim/model',
  summary: 'A Deployment-like group of pods on a node pool; create one with `pods(name, spec)`.',
  signature: 'class PodGroup extends Sink { readonly kind: "pods"; readonly spec: PodGroupSpec }',
  seeAlso: ['pods', 'Sink'],
  guide: 'capacity',
})

export const pods = (name: string, spec: PodGroupSpec): PodGroup => new PodGroup(name, spec)

doc({
  name: 'pods',
  kind: 'function',
  module: 'pricesim/model',
  summary: 'A group of identical pods (a Deployment) owned by a service and running on a node pool.',
  signature: 'pods(name: string, spec: PodGroupSpec): PodGroup',
  params: [
    { name: 'name', type: 'string', doc: 'Unique across the model; the pools report uses it.' },
    { name: 'spec.on', type: 'NodePool', doc: 'The node pool the pods run on.' },
    {
      name: 'spec.request',
      type: '{ cpu: Expr<millicore>; memory: Expr<byte>; network?: Expr<byte/s> }',
      doc: 'Per-pod resource requests (limits are taken as equal). Declare `network` to size on network; without it, network demand on the pods throws.',
    },
    { name: 'spec.minReplicas', type: 'number', doc: 'Minimum replicas, provisioned even with no traffic.' },
    {
      name: 'spec.targetUtilization',
      type: 'number',
      doc: 'Target utilization (0–1) of each requested resource at peak.',
    },
  ],
  returns:
    "A `PodGroup`. List it in a service's `pools` and demand from it: `pool.cpu(…)` and `.network(…)` per request, `.memory(…)` as a level in `gaugeUse`, `.use(name, …)` / `.hold(name, …)` for custom resources. `.disk`, `.ebsBandwidth` and `.ebsIops` are not available on pods (they throw at evaluation).",
  guidance: `
- **Replicas:** max(\`minReplicas\`, ceil(peak demand / (pod request × \`targetUtilization\`))) over each requested resource (cpu, memory, network if declared, custom resources); the largest is the binding one.
- The node pool is then sized from replicas × requests of all pod groups on it (see \`nodePool\`).
- Unused request capacity shows as idle \`pod headroom: <group>\` under the node pool.
- Custom capacity declared on pods is per pod, derived from the pod's request (\`hw.cpu\` is the pod's cpu request, not the node's).`,
  examples: [
    `import { q, u } from 'pricesim'
import { gauge, nodePool, pods, request, service } from 'pricesim/model'
import { ec2 } from 'pricesim/aws'

const general = nodePool('general', {
  instance: ec2['m7g.xlarge'],
  min: 3,
  azs: 3,
  reserved: { cpu: q(400, u.millicore), memory: q(1.5, u.GiB) },
  maxPods: 58,
  packingEfficiency: 0.85,
})
const coreMs = u.vCPU.mul(u.ms)

export const api = service('api', {
  pools: {
    web: pods('api-web', {
      on: general,
      request: { cpu: q(1000, u.millicore), memory: q(2, u.GiB) },
      minReplicas: 2,
      targetUtilization: 0.6,
    }),
  },
  gauges: { sessions: gauge(u.count) },
  requests: ({ pools }) => ({
    get: request({}, () => ({ use: [pools.web.cpu(q(2, coreMs))] })),
  }),
  // 50 KB of memory per open session
  gaugeUse: (g, { pools }) => [pools.web.memory(g.sessions.mul(q(50, u.KB.div(u.count))))],
})`,
  ],
  seeAlso: ['nodePool', 'instancePool', 'Sink', 'service'],
  guide: 'capacity',
})

/**
 * A block-storage volume type (e.g. EBS gp3): what one volume provides and how it is billed. The catalog
 * supplies these (src/catalog/aws/ebs.ts); the engine only needs the provisioned numbers.
 */
export interface VolumeType {
  readonly id: string
  /**
   * Provisioned performance and billed usage of one volume, from its size and optional provisioned IOPS and
   * throughput (base units: byte, op/s, byte/s). Throws on a spec the type doesn't allow.
   */
  readonly provision: (v: {
    readonly size: number
    readonly iops?: number
    readonly throughput?: number
  }) => VolumeProvision
}

export interface VolumeProvision {
  /** provisioned IOPS (op/s) and throughput (byte/s), including what the type gives for free */
  readonly iops: number
  readonly throughput: number
  /** usage of each billing dimension per volume-second, in base units of the dimension's usage unit */
  readonly usage: readonly { readonly dimension: BillingDimension; readonly perSecond: number }[]
}

/** Volumes attached to every instance (or node) of a pool: `count` identical volumes of one spec. */
export interface VolumeSpec {
  readonly type: VolumeType
  /** identical volumes of this spec per instance (default 1) */
  readonly count?: number
  readonly size: Expr<{ byte: 1 }>
  /** provisioned IOPS; default: the type's baseline */
  readonly iops?: Expr<{ op: 1; s: -1 }>
  /** provisioned throughput; default: the type's baseline */
  readonly throughput?: Expr<{ byte: 1; s: -1 }>
}

docs([
  {
    name: 'VolumeSpec',
    kind: 'type',
    module: 'pricesim/model',
    summary: 'Block volumes attached to every instance (node) of a pool: `count` identical volumes of one spec.',
    signature:
      'interface VolumeSpec { type: VolumeType; count?: number; size: Expr<byte>; iops?: Expr<op/s>; throughput?: Expr<byte/s> }',
    params: [
      { name: 'type', type: 'VolumeType', doc: 'The volume type, e.g. `gp3` from `pricesim/aws`.' },
      { name: 'count', type: 'number', optional: true, default: '1', doc: 'Volumes per instance; a positive integer.' },
      { name: 'size', type: 'Expr<byte>', doc: 'Size of one volume.' },
      {
        name: 'iops',
        type: 'Expr<op/s>',
        optional: true,
        doc: "Provisioned IOPS per volume; default the type's baseline.",
      },
      {
        name: 'throughput',
        type: 'Expr<byte/s>',
        optional: true,
        doc: "Provisioned throughput per volume; default the type's baseline.",
      },
    ],
    guidance: `
- Per instance, volumes add \`disk\` (local NVMe + Σ size), and set \`ebsIops\` / \`ebsBandwidth\` to min(instance EBS limit, Σ volume IOPS / throughput); the volumes' figures alone when the instance has no known limit. Without volumes, the EBS resources are the instance's limits.
- Volumes are billed per instance, and split between used and idle like the instance-hours.
- The volume type throws on a spec it doesn't allow (e.g. gp3 IOPS above its maximum).`,
    seeAlso: ['instancePool', 'nodePool', 'gp3'],
    guide: 'capacity',
  },
  {
    name: 'VolumeType',
    kind: 'type',
    module: 'pricesim/model',
    summary:
      'A block-storage volume type (e.g. EBS gp3): what one volume provides and how it is billed. The catalog supplies these.',
    signature:
      'interface VolumeType { id: string; provision(v: { size: number; iops?: number; throughput?: number }): VolumeProvision }',
    seeAlso: ['VolumeSpec', 'gp3'],
    guide: 'capacity',
  },
])

export const provisionVolume = (v: VolumeSpec, b: Bindings): VolumeProvision & { readonly size: number } => {
  const size = v.size.eval(b)
  return {
    size,
    ...v.type.provision({
      size,
      ...(v.iops ? { iops: v.iops.eval(b) } : {}),
      ...(v.throughput ? { throughput: v.throughput.eval(b) } : {}),
    }),
  }
}

/**
 * Per-instance (per-node) capacity in base units; a resource is absent when neither the instance type nor
 * its volumes provide it. With volumes (summed over every volume, `count` included):
 *   disk         = local NVMe (if any) + total volume size
 *   ebsIops      = min(instance EBS IOPS limit, total volume IOPS); the volumes' alone when the limit is unknown
 *   ebsBandwidth = min(instance EBS bandwidth limit, total volume throughput); likewise
 * Without volumes, the EBS resources are the instance's limits (as if volumes were sized to match).
 */
export const nodeCapacity = (
  instance: InstanceType,
  b: Bindings,
  volumes: readonly VolumeSpec[] = [],
): Partial<Record<Resource, number>> => {
  const c = instance.capacity
  const vols = volumes.map((v) => ({ n: volumeCount(v), p: provisionVolume(v, b) }))
  const sum = (f: (p: VolumeProvision & { size: number }) => number) =>
    vols.length ? vols.reduce((a, x) => a + x.n * f(x.p), 0) : undefined
  const capped = (limit: number | undefined, v: number | undefined) =>
    v === undefined ? limit : limit === undefined ? v : Math.min(limit, v)
  const ebsBandwidth = capped(
    c.ebsBandwidth?.eval(b),
    sum((p) => p.throughput),
  )
  const ebsIops = capped(
    c.ebsIops?.eval(b),
    sum((p) => p.iops),
  )
  const volSize = sum((p) => p.size)
  const disk = c.nvme || volSize !== undefined ? (c.nvme?.bytes.eval(b) ?? 0) + (volSize ?? 0) : undefined
  return {
    cpu: c.cpu.eval(b),
    memory: c.memory.eval(b),
    network: c.network.eval(b),
    ...(ebsBandwidth !== undefined ? { ebsBandwidth } : {}),
    ...(ebsIops !== undefined ? { ebsIops } : {}),
    ...(disk !== undefined ? { disk } : {}),
  }
}

const volumeCount = (v: VolumeSpec) => {
  const n = v.count ?? 1
  if (!Number.isInteger(n) || n < 1) throw new Error(`volume count must be a positive integer, got ${n}`)
  return n
}

/** What one instance (node) of a pool bills per second: its instance-hours plus its volumes' dimensions. */
export const perNodeBills = (
  instance: InstanceType,
  b: Bindings,
  volumes: readonly VolumeSpec[] = [],
): readonly { readonly dimension: BillingDimension; readonly perSecond: number }[] => [
  { dimension: instance.price, perSecond: 1 },
  ...volumes.flatMap((v) =>
    provisionVolume(v, b)
      .usage.filter((x) => x.perSecond !== 0)
      .map((x) => ({ dimension: x.dimension, perSecond: x.perSecond * volumeCount(v) })),
  ),
]

/**
 * Per-instance (per-pod) hardware as expressions, for services to derive software capacity from (e.g.
 * partitions = 3 per core). `disk` is local NVMe plus attached volume sizes, when there are any.
 */
export interface Hardware {
  readonly cpu: Expr<{ millicore: 1 }>
  readonly memory: Expr<{ byte: 1 }>
  readonly network?: Expr<{ byte: 1; s: -1 }>
  readonly disk?: Expr<{ byte: 1 }>
}

doc({
  name: 'Hardware',
  kind: 'type',
  module: 'pricesim/model',
  summary:
    'Per-instance (per-pod) hardware as expressions, passed to `service({ capacity })` to derive software capacity from.',
  signature:
    'interface Hardware { cpu: Expr<millicore>; memory: Expr<byte>; network?: Expr<byte/s>; disk?: Expr<byte> }',
  guidance: `
- For an instance pool: the instance type's cpu, memory and network, and \`disk\` = local NVMe + volume sizes × count (absent when there are neither).
- For pods: the pod's requests (cpu, memory, and network when declared); no disk.`,
  seeAlso: ['service', 'Sink'],
  guide: 'capacity',
})

const hardwareOf = (instance: InstanceType, volumes: readonly VolumeSpec[] = []): Hardware => {
  const c = instance.capacity
  const parts: Expr<{ byte: 1 }>[] = [
    ...(c.nvme ? [c.nvme.bytes] : []),
    ...volumes.map((v) => v.size.mul(volumeCount(v))),
  ]
  const disk = parts.length ? parts.reduce((a, x) => a.add(x)) : undefined
  return { cpu: c.cpu, memory: c.memory, network: c.network, ...(disk ? { disk } : {}) }
}

/** Per-pod requests in base units (network only when declared), plus custom capacity declared per pod. */
export const podRequests = (g: PodGroup, b: Bindings): Partial<Record<ResourceName, number>> => {
  const r = g.spec.request
  return {
    cpu: r.cpu.eval(b),
    memory: r.memory.eval(b),
    ...(r.network ? { network: r.network.eval(b) } : {}),
    ...customCapacities(g, b),
  }
}

/** Per-instance (per-pod) custom capacity declared on a sink, in base units. */
export const customCapacities = (s: Sink, b: Bindings): Record<string, number> =>
  Object.fromEntries(s.customResources().map((k) => [k, s.customCapacity(k)!.eval(b)]))

docs([
  {
    name: 'provisionVolume',
    kind: 'function',
    module: 'pricesim/model',
    summary:
      "Evaluate a `VolumeSpec` into one volume's size, provisioned IOPS/throughput and billed usage (base units).",
    internal: true,
  },
  {
    name: 'nodeCapacity',
    kind: 'function',
    module: 'pricesim/model',
    summary: 'Per-instance capacity of each built-in resource in base units, including attached volumes.',
    internal: true,
  },
  {
    name: 'perNodeBills',
    kind: 'function',
    module: 'pricesim/model',
    summary: 'What one instance (node) of a pool bills per second: its instance-hours plus its volumes.',
    internal: true,
  },
  {
    name: 'podRequests',
    kind: 'function',
    module: 'pricesim/model',
    summary: "A pod group's per-pod requests and custom capacities, in base units.",
    internal: true,
  },
  {
    name: 'customCapacities',
    kind: 'function',
    module: 'pricesim/model',
    summary: 'Per-instance (per-pod) custom capacity declared on a sink, in base units.',
    internal: true,
  },
])
