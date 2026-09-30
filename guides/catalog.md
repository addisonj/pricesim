---
title: The AWS catalog
summary: What pricesim/aws provides, how to find an instance or a price, and its sources.
order: 5
---

`pricesim/aws` has ready-made offerings and billing dimensions at us-east-1 list prices. List it with `pricesim api --module pricesim/aws`; every entry says what request types and gauges it exposes and which prices it uses.

## What's there

- **Compute:** `ec2['<type>']` for every current-generation instance type (capacity: vCPU, memory, network, EBS bandwidth and IOPS, NVMe), with on-demand, Reserved Instance and Savings Plan rates (`ec2Rates`, `ec2CommitmentDiscount`).
- **Block storage:** `gp3` volumes (`volumes: [{ type: gp3, size, iops?, throughput? }]` on a pool).
- **Object storage:** `s3Bucket`, `s3ExpressBucket`.
- **Databases:** `dynamoTable`, `auroraPostgres` (and Aurora instance types).
- **Networking:** `applicationLoadBalancer`, `networkLoadBalancer`, `natGateway`, `internetEgress`, `privateLinkEndpoint`, `directConnect` (pay-as-you-go and flat-rate port pairs), inter-region and same-region public transfer, and `interAz` (the cross-AZ transfer dimension scenarios need for edges).

## Finding things

```sh
pricesim api --module pricesim/aws     # everything in the catalog
pricesim api balancer                  # search by word
pricesim describe networkLoadBalancer  # request types, gauges, prices, sources
```

Instance types are keys of `ec2`: `ec2['m7g.xlarge']`, `ec2['c8gn.4xlarge']`. A typo is a compile error, and the editor completes the names.

## Using it

```ts
import { pricing } from 'pricesim'
import { instancePool } from 'pricesim/model'
import { ec2, ec2CommitmentDiscount } from 'pricesim/aws'

export const brokers = instancePool('brokers', { instance: ec2['m7g.2xlarge'], min: 3, loadFactor: 0.6, azs: 3 })

// a 1-year compute Savings Plan on EC2, 40% off cross-AZ transfer
export const committed = pricing({
  familyDiscounts: {
    'aws.ec2': ec2CommitmentDiscount('m7g.2xlarge', 'computeSavingsPlan1yNoUpfront') ?? 0,
    'aws.transfer.inter-az': 0.4,
  },
})
```

## Sources and freshness

Prices are generated from the AWS price list (`pnpm gen:aws` in the pricesim repo writes `src/catalog/aws/*.gen.ts`) or typed in from pricing pages; each dimension carries `source.url` and `source.retrieved`. `SOURCES` and `RETRIEVED` list them. Check the date before quoting a number, and write your own `dimension(…)` for anything negotiated or missing.
