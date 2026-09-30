// Intentional mistakes, one per line, to judge error readability.
import { q, u, sym, max, request, pool, bill, dimension } from '#core'
import { ec2 } from './catalog.gen.js'
import { logStore, s3x } from './model.js'

// E1: add bytes to a byte rate
export const e1 = q(2, u.GB).add(q(1, u.GB.div(u.s)))

// E2: max(count, millicores)
const cpu = sym('cpu', u.millicore)
export const e2 = max(q(3, u.count), cpu)

// E3: pass a count where a request attribute expects bytes
export const e3 = logStore.requests.append({ bytes: q(10, u.count) })

// E4: forget the per-request time factor for CPU (millicore instead of millicore*s) — Same<> style param
const p = pool('p', { instance: ec2['m7g.large'], min: 3, azs: 3, loadFactor: q(0.6, u.one) })
export const e4 = p.cpu(q(20, u.millicore))

// E5: same kind of mistake on an invariant-typed param (network expects bytes per request)
export const e5 = p.network(q(1, u.GB.div(u.s)))

// E6: bill GB*month usage with a plain GB value
const storage = dimension('aws.s3express.storage', u.GB.mul(u.month))
export const e6 = bill(storage, q(4, u.TiB))

// E7: assign a derived expression to the wrong declared type
export const e7: import('#core').Expr<{ USD: 1 }> = q(1, u.USD.div(u.hour)).mul(q(3, u.count))

// E8: unknown request on a dependency
export const e8 = s3x.requests.delete({ bytes: q(1, u.byte) })

// E9: exponent overflow (byte^5)
const b = q(1, u.byte)
export const e9 = b.mul(b).mul(b).mul(b).mul(b).add(q(1, u.byte))

// E10: missing attribute in request body use
export const e10 = request({ bytes: u.byte }, (r) => ({ use: [p.cpu(r.size)] }))
