// Result details: billing dimensions, pool sizing, tenants, and revenue / margin under the price book.
import { useState } from 'preact/hooks'
import type { PoolReport, Result } from 'pricesim'
import { money, num, pct, quantity } from '../model/format.ts'

const ShareBar = ({ share }: { share: number }) => (
  <td class="sharecell">
    <div class="sharebar" style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }} />
  </td>
)

export const Dimensions = ({ result: r }: { result: Result }) => {
  const [filter, setFilter] = useState('')
  const f = filter.toLowerCase()
  const rows = r.dimensions.filter((d) => !f || d.id.toLowerCase().includes(f) || d.family.toLowerCase().includes(f))
  const accounts = r.dimensions.some((d) => d.account)
  return (
    <div class="card">
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <h2>Billing dimensions</h2>
        <span class="muted">{r.dimensions.length}</span>
        <input
          type="text"
          placeholder="filter"
          style={{ marginLeft: 'auto' }}
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>dimension</th>
              <th>family</th>
              {accounts && <th>account</th>}
              <th class="num">usage / month</th>
              <th class="num">effective rate</th>
              <th class="num">cost</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr>
                <td title={d.source}>{d.id}</td>
                <td class="secondary">{d.family}</td>
                {accounts && <td class="secondary">{d.account}</td>}
                <td class="num">
                  {num(d.usage)} <span class="muted">{d.unit}</span>
                </td>
                <td class="num">
                  {d.effectiveRate ? `$${d.effectiveRate.toPrecision(3)}` : '–'} <span class="muted">/{d.unit}</span>
                </td>
                <td class="num">{money(d.cost)}</td>
                <ShareBar share={r.total > 0 ? d.cost / r.total : 0} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const RESOURCE_UNITS: Record<string, string> = {
  cpu: 'millicore',
  memory: 'byte',
  network: 'byte/s',
  ebsBandwidth: 'byte/s',
  ebsIops: 'op/s',
  pods: 'count',
}

const Pool = ({ pool: p }: { pool: PoolReport }) => (
  <div class="pool">
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <strong>{p.name}</strong>
      <span class="kind">{p.kind}</span>
      <span class="count" style={{ marginLeft: 'auto' }}>
        {p.count}
      </span>
    </div>
    <div class="muted" style={{ fontSize: 12 }}>
      {p.instance ?? ''}
      {p.nodePool ? ` on ${p.nodePool}` : ''} · min {p.min} · bound by <strong class="secondary">{p.binding}</strong>
    </div>
    {Object.entries(p.resources).map(([name, s]) => {
      if (!s) return null
      const unit = RESOURCE_UNITS[name] ?? ''
      const peak = s.capacity > 0 ? s.peak / s.capacity : 0
      const mean = s.capacity > 0 ? s.mean / s.capacity : 0
      return (
        <div
          class={`util${p.binding === name ? ' binding' : ''}`}
          title={`${name}: peak ${quantity(s.peak, unit)}, mean ${quantity(s.mean, unit)}, capacity ${quantity(s.capacity, unit)}`}
        >
          <span class="name">{name}</span>
          <div class="track">
            <div class="peak" style={{ width: `${Math.min(1, peak) * 100}%` }} />
            <div class="mean" style={{ width: `${Math.min(1, mean) * 100}%` }} />
          </div>
          <span class="num">{pct(peak, 0)}</span>
        </div>
      )
    })}
  </div>
)

export const Pools = ({ pools }: { pools: readonly PoolReport[] }) =>
  pools.length ? (
    <div class="card">
      <h2>
        Pools <span class="muted">(count · utilization: mean solid, peak light, % = peak / capacity)</span>
      </h2>
      <div class="pools">
        {pools.map((p) => (
          <Pool pool={p} />
        ))}
      </div>
    </div>
  ) : null

const TOP = 25

export const Tenants = ({ result: r }: { result: Result }) => {
  const [all, setAll] = useState(false)
  if (!r.tenants?.length) return null
  const rows = [...r.tenants].sort((a, b) => b.total - a.total)
  const shown = all ? rows : rows.slice(0, TOP)
  return (
    <div class="card">
      <h2>
        Tenants <span class="muted">{rows.length}</span>
      </h2>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>tenant</th>
              <th class="num">used</th>
              <th class="num">idle share</th>
              <th class="num">fixed share</th>
              <th class="num">total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr>
                <td>{t.id}</td>
                <td class="num">{money(t.used)}</td>
                <td class="num">{money(t.idleShare)}</td>
                <td class="num">{money(t.fixedShare)}</td>
                <td class="num">{money(t.total)}</td>
                <ShareBar share={r.total > 0 ? t.total / r.total : 0} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > TOP && (
        <button class="link" onClick={() => setAll(!all)}>
          {all ? `show top ${TOP}` : `show all ${rows.length}`}
        </button>
      )}
    </div>
  )
}

const Margin = ({ v }: { v: number }) => <td class={`num ${v < 0 ? 'bad' : ''}`}>{money(v)}</td>

export const Revenue = ({ result: r }: { result: Result }) => {
  const rev = r.revenue
  if (!rev) return null
  return (
    <div class="card">
      <h2>
        Revenue and margin <span class="muted">· {rev.priceBook}</span>
      </h2>
      <div class="row2">
        <div>
          <h3>Per meter</h3>
          <table>
            <thead>
              <tr>
                <th>meter</th>
                <th class="num">quantity</th>
                <th class="num">revenue</th>
                <th class="num">cost</th>
                <th class="num">margin</th>
              </tr>
            </thead>
            <tbody>
              {rev.meters.map((m) => (
                <tr>
                  <td>{m.name}</td>
                  <td class="num">
                    {num(m.quantity)} <span class="muted">{m.unit}</span>
                  </td>
                  <td class="num">{money(m.revenue)}</td>
                  <td class="num">{money(m.cost)}</td>
                  <Margin v={m.margin} />
                </tr>
              ))}
              {rev.unallocated !== 0 && (
                <tr>
                  <td class="secondary">unallocated (idle, fixed, unmetered)</td>
                  <td />
                  <td />
                  <td class="num">{money(rev.unallocated)}</td>
                  <Margin v={-rev.unallocated} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div>
          <h3>Lines</h3>
          <table>
            <thead>
              <tr>
                <th>line</th>
                <th>kind</th>
                <th class="num">quantity</th>
                <th class="num">amount</th>
              </tr>
            </thead>
            <tbody>
              {rev.lines.map((l) => (
                <tr>
                  <td>{l.name}</td>
                  <td class="secondary">{l.kind}</td>
                  <td class="num">
                    {l.quantity !== undefined ? num(l.quantity) : ''} <span class="muted">{l.unit ?? ''}</span>
                  </td>
                  <td class="num">{money(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <h3>Per customer</h3>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>customer</th>
              <th>plan</th>
              <th class="num">revenue</th>
              <th class="num">cost</th>
              <th class="num">margin</th>
              <th class="num">margin rate</th>
            </tr>
          </thead>
          <tbody>
            {rev.customers.map((c) => (
              <tr>
                <td>{c.id}</td>
                <td class="secondary">
                  {Object.entries(c.plan)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ')}
                </td>
                <td class="num">{money(c.revenue)}</td>
                <td class="num">{money(c.cost)}</td>
                <Margin v={c.margin} />
                <td class={`num ${c.margin < 0 ? 'bad' : ''}`}>{pct(c.marginRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
