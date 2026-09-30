import { describe, expect, it } from 'vitest'
import { familyDiscount, freeTier, pricing, scheduleCost, tiered } from '../src/index.ts'
import { interAz } from '../src/catalog/aws/index.ts'

describe('price schedules', () => {
  const s3 = tiered([
    { upTo: 50_000, rate: 0.023 },
    { upTo: 500_000, rate: 0.022 },
    { upTo: null, rate: 0.021 },
  ])

  it('applies tiers cumulatively', () => {
    expect(scheduleCost(s3, 10_000)).toBeCloseTo(230)
    expect(scheduleCost(s3, 100_000)).toBeCloseTo(50_000 * 0.023 + 50_000 * 0.022)
    expect(scheduleCost(s3, 600_000)).toBeCloseTo(50_000 * 0.023 + 450_000 * 0.022 + 100_000 * 0.021)
  })

  it('applies free tiers before the paid schedule', () => {
    expect(scheduleCost(freeTier(25, 0.25), 10)).toBe(0)
    expect(scheduleCost(freeTier(25, 0.25), 125)).toBeCloseTo(25)
  })
})

describe('pricing context', () => {
  it('resolves region multipliers and longest-prefix family discounts', () => {
    const ctx = pricing({ region: 'ap-southeast-1', familyDiscounts: { 'aws.ec2': 0.2, 'aws.ec2.compute': 0.3 } })
    expect(ctx.regionMultiplier).toBe(1.3)
    expect(familyDiscount(ctx, 'aws.ec2.compute')).toBe(0.3)
    expect(familyDiscount(ctx, 'aws.ec2.other')).toBe(0.2)
    expect(familyDiscount(ctx, 'aws.s3')).toBe(0)
    expect(() => pricing({ region: 'mars-north-1' })).toThrow(/no region multiplier/)
  })
})

describe('inter-AZ transfer family', () => {
  it('can be discounted on its own, and by an aws.transfer discount', () => {
    expect(interAz.family).toBe('aws.transfer.inter-az')
    expect(familyDiscount(pricing({ familyDiscounts: { 'aws.transfer.inter-az': 0.4 } }), interAz.family)).toBe(0.4)
    expect(familyDiscount(pricing({ familyDiscounts: { 'aws.transfer': 0.1 } }), interAz.family)).toBe(0.1)
  })
})
