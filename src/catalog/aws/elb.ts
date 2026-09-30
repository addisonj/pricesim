// Elastic Load Balancing: Application and Network Load Balancers. Each bills an hourly charge per load
// balancer plus capacity units (LCU for ALB, NLCU for NLB) per hour.
//
// Simplification: AWS bills the LCUs of the dimension with the highest usage in each hour, out of new
// connections, active connections, processed bytes and (ALB only) rule evaluations. That max is not linear
// in the traffic, so these offerings bill the processed-bytes dimension only. One LCU/NLCU covers 1 GB
// processed per hour (EC2, IP and container targets; ALB Lambda targets get 0.4 GB per hour, not modeled),
// so the billed LCU-hours are GB processed / 1 GB. This underbills workloads dominated by many small
// requests or connections: for ALB, more than ~25 new connections/s or ~1,000 rule evaluations/s per GB/hour
// processed; for TCP NLB, more than ~800 new connections/s. Partial-hour rounding is not modeled either.
import { q } from '../../core/expr.ts'
import { u } from '../../core/units.ts'
import { doc } from '../../docs/registry.ts'
import { offering } from '../../model/node.ts'
import { bill, fixedCharge, request } from '../../model/request.ts'
import { dimension, type BillingDimension } from '../../pricing/dimension.ts'
import { SOURCES } from './sources.ts'

type Hours = BillingDimension<{ s: 1 }>

const elb = (id: string, rate: number): Hours =>
  dimension(`aws.elb.${id}`, u.hour, rate, { family: 'aws.elb', source: SOURCES.elb })

export const elbRates = {
  albHours: elb('alb.hours', 0.0225),
  /** LCU-hours: the usage unit is hours of one LCU */
  albLcuHours: elb('alb.lcu-hours', 0.008),
  nlbHours: elb('nlb.hours', 0.0225),
  /** NLCU-hours: the usage unit is hours of one NLCU */
  nlbLcuHours: elb('nlb.lcu-hours', 0.006),
}

doc({
  name: 'elbRates',
  kind: 'catalog',
  module: 'pricesim/aws',
  summary: 'Load balancer billing dimensions: ALB and NLB hours, LCU-hours and NLCU-hours.',
  signature: 'elbRates: { albHours; albLcuHours; nlbHours; nlbLcuHours }',
  guidance:
    '- `albHours` $0.0225/hour, `albLcuHours` $0.008 per LCU-hour, `nlbHours` $0.0225/hour, `nlbLcuHours` $0.006 per NLCU-hour. Family `aws.elb`, us-east-1, retrieved 2026-09-24.',
  seeAlso: ['applicationLoadBalancer', 'networkLoadBalancer'],
  guide: 'catalog',
})

/** processed bytes covered by one LCU (and one NLCU) for an hour */
const BYTES_PER_LCU_HOUR = q(1, u.GB)

const loadBalancer = (name: string, hours: Hours, lcuHours: Hours, count: number) =>
  offering(name, {
    fixed: [fixedCharge(hours, count)],
    requests: () => ({
      /** one request (or connection) through the load balancer; `bytes` processed in both directions */
      forward: request({ bytes: u.byte }, (r) => ({
        bill: [bill(lcuHours, r.bytes.div(BYTES_PER_LCU_HOUR).mul(q(1, u.hour)))],
      })),
    }),
  })

/** An Application Load Balancer (or `count` of them). LCUs are billed from processed bytes only; see above. */
export const applicationLoadBalancer = (name: string, opts: { count?: number } = {}) =>
  loadBalancer(`alb:${name}`, elbRates.albHours, elbRates.albLcuHours, opts.count ?? 1)

doc({
  name: 'applicationLoadBalancer',
  kind: 'function',
  module: 'pricesim/aws',
  summary:
    'An Application Load Balancer offering (or `count` of them): hourly charge plus LCU-hours from processed bytes.',
  signature: 'applicationLoadBalancer(name: string, opts?: { count?: number }): Offering',
  params: [
    { name: 'name', type: 'string', doc: 'Node name is `alb:<name>`.' },
    {
      name: 'opts.count',
      type: 'number',
      optional: true,
      default: '1',
      doc: 'Load balancers, each billed $0.0225/hour.',
    },
  ],
  returns: "An offering; add it to a service's `deps` (its hourly charge becomes a fixed charge of the scenario).",
  guidance: `
- **Request:** \`forward({ bytes })\`, one request or connection with \`bytes\` processed in both directions; bills \`bytes / 1 GB\` LCU-hours at $0.008.
- **Fixed:** \`count\` × $0.0225 per hour, whether or not there is traffic.
- LCUs come from processed bytes only. AWS bills the largest of new connections, active connections, processed bytes and rule evaluations, so this underbills traffic dominated by many small requests or connections (above ~25 new connections/s or ~1,000 rule evaluations/s per GB/hour). Lambda targets and partial-hour rounding are not modeled.`,
  examples: [
    `import { u } from 'pricesim'
import { request, service } from 'pricesim/model'
import { applicationLoadBalancer } from 'pricesim/aws'

const lb = applicationLoadBalancer('web')
export const web = service('web', {
  deps: { lb },
  requests: ({ deps }) => ({
    page: request({ bytes: u.byte }, (r) => ({ calls: [deps.lb.forward({ bytes: r.bytes })] })),
  }),
})`,
  ],
  seeAlso: ['networkLoadBalancer', 'elbRates'],
  guide: 'catalog',
})

/** A Network Load Balancer (or `count` of them). NLCUs are billed from processed bytes only; see above. */
export const networkLoadBalancer = (name: string, opts: { count?: number } = {}) =>
  loadBalancer(`nlb:${name}`, elbRates.nlbHours, elbRates.nlbLcuHours, opts.count ?? 1)

doc({
  name: 'networkLoadBalancer',
  kind: 'function',
  module: 'pricesim/aws',
  summary: 'A Network Load Balancer offering (or `count` of them): hourly charge plus NLCU-hours from processed bytes.',
  signature: 'networkLoadBalancer(name: string, opts?: { count?: number }): Offering',
  params: [
    { name: 'name', type: 'string', doc: 'Node name is `nlb:<name>`.' },
    {
      name: 'opts.count',
      type: 'number',
      optional: true,
      default: '1',
      doc: 'Load balancers, each billed $0.0225/hour.',
    },
  ],
  returns: "An offering; add it to a service's `deps`.",
  guidance: `
- **Request:** \`forward({ bytes })\`: bills \`bytes / 1 GB\` NLCU-hours at $0.006.
- **Fixed:** \`count\` × $0.0225 per hour.
- NLCUs come from processed bytes only, so TCP traffic above ~800 new connections/s per GB/hour is underbilled.
- The provider side of a PrivateLink endpoint service is this NLB; PrivateLink adds no provider charge within a region.`,
  seeAlso: ['applicationLoadBalancer', 'elbRates', 'privateLinkEndpoint'],
  guide: 'catalog',
})
