import { q, u, parseQuantity } from '#core'
import { gateway, monthlyNodeCost } from './model.js'
console.log('model loaded:', Object.keys(gateway.requests).length, 'gateway requests; cost dim =', JSON.stringify(monthlyNodeCost.dim))
try { (q(2, u.GB) as any).add(q(1, u.GB.div(u.s))) } catch (e) { console.log('runtime:', (e as Error).message) }
try { parseQuantity('5 GB').as(u.req.div(u.s)) } catch (e) { console.log('boundary:', (e as Error).message) }
