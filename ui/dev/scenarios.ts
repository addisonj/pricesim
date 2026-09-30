// The repository's example scenarios, by display name (shared by the page and the evaluation worker).
import type { Scenario } from 'pricesim'
import uploads, { shared, sharedPriced } from '../../examples/guide-example.ts'
import events from '../../examples/multi-tenant.ts'
import orders from '../../examples/orders-platform.ts'

export const scenarios: Record<string, Scenario> = {
  uploads,
  'uploads-shared': shared,
  'uploads-shared-priced': sharedPriced,
  orders,
  'events (200 tenants)': events,
}
