// Scenarios side by side (each with its current input overrides): totals, margin, and cost by dimension family.
import { useEffect, useMemo, useState } from 'preact/hooks'
import type { Result } from 'pricesim'
import { slotColor, SLOTS } from '../model/colors.ts'
import { money, moneyShort, pct } from '../model/format.ts'
import type { Evaluator, Outcome } from '../model/run.ts'
import type { Entry } from './Simulator.tsx'

type Metric = { label: string; get: (r: Result) => number | null | undefined; rate?: boolean }

const METRICS: Metric[] = [
  { label: 'total', get: (r) => r.total },
  { label: 'used', get: (r) => r.used },
  { label: 'idle', get: (r) => r.idle },
  { label: 'fixed', get: (r) => r.fixed },
  { label: 'revenue', get: (r) => r.revenue?.revenue },
  { label: 'margin', get: (r) => r.revenue?.margin },
  { label: 'margin rate', get: (r) => r.revenue?.marginRate, rate: true },
]

const byFamily = (r: Result): Map<string, number> => {
  const m = new Map<string, number>()
  for (const d of r.dimensions) m.set(d.family, (m.get(d.family) ?? 0) + d.cost)
  return m
}

export const Compare = ({ evaluator, entries }: { evaluator: Evaluator; entries: readonly Entry[] }) => {
  const [picked, setPicked] = useState<readonly string[]>(() => entries.slice(0, 3).map((e) => e.name))
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const chosen = entries.filter((e) => picked.includes(e.name))

  useEffect(() => {
    let live = true
    const t = setTimeout(async () => {
      for (const e of chosen) {
        const o = await evaluator.evaluate(e, e.overrides, `compare:${e.name}`)
        if (!live) return
        if (o.ok || !o.superseded) setOutcomes((prev) => ({ ...prev, [e.name]: o }))
      }
    }, 50)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [evaluator, entries, picked])

  const results = chosen.flatMap((e) => {
    const o = outcomes[e.name]
    return o?.ok ? [{ name: e.name, r: o.result }] : []
  })
  const failed = chosen.flatMap((e) => {
    const o = outcomes[e.name]
    return o && !o.ok ? [{ name: e.name, error: o.error }] : []
  })

  // families ordered by their largest cost in any scenario; past the palette, fold into 'other'
  const { families, fam } = useMemo(() => {
    const fam = results.map(({ name, r }) => ({ name, m: byFamily(r) }))
    const max = new Map<string, number>()
    for (const { m } of fam) for (const [f, v] of m) max.set(f, Math.max(max.get(f) ?? 0, v))
    const families = [...max].sort((a, b) => b[1] - a[1]).map(([f]) => f)
    return { families, fam }
  }, [outcomes, picked])
  const shownFamilies = families.length > SLOTS ? families.slice(0, SLOTS - 1) : families
  const folded = families.slice(shownFamilies.length)
  const valueOf = (m: Map<string, number>, f: string) =>
    f === 'other' ? folded.reduce((a, x) => a + (m.get(x) ?? 0), 0) : (m.get(f) ?? 0)
  const bars = folded.length ? [...shownFamilies, 'other'] : shownFamilies
  const colorOf = (i: number, f: string) => (f === 'other' ? 'var(--series-other)' : slotColor(i))
  const maxTotal = Math.max(1e-9, ...results.map(({ r }) => r.total))
  const base = results[0]

  const toggle = (name: string) => setPicked((p) => (p.includes(name) ? p.filter((n) => n !== name) : [...p, name]))

  return (
    <div class="page">
      <div class="card">
        <h2>Scenarios</h2>
        <div class="picker">
          {entries.map((e) => (
            <label>
              <input type="checkbox" checked={picked.includes(e.name)} onChange={() => toggle(e.name)} />
              {e.name}
              {Object.keys(e.overrides).length > 0 && (
                <span class="muted">({Object.keys(e.overrides).length} overrides)</span>
              )}
            </label>
          ))}
        </div>
        <div class="muted" style={{ marginTop: 6, fontSize: 12 }}>
          Each scenario is evaluated with its current input overrides. Use “Duplicate” on the Explore tab to compare
          variants of one scenario. Deltas are against the first column.
        </div>
        {failed.map((f) => (
          <div class="error">
            {f.name}: {f.error}
          </div>
        ))}
      </div>
      {results.length > 0 && (
        <>
          <div class="card">
            <h2>Totals (USD / month)</h2>
            <table>
              <thead>
                <tr>
                  <th />
                  {results.map(({ name }) => (
                    <th class="num">{name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {METRICS.filter((m) => results.some(({ r }) => m.get(r) !== undefined)).map((m) => (
                  <tr>
                    <td class="secondary">{m.label}</td>
                    {results.map(({ r }, i) => {
                      const v = m.get(r)
                      const b = base && m.get(base.r)
                      const d = i > 0 && typeof v === 'number' && typeof b === 'number' ? v - b : 0
                      return (
                        <td class="num">
                          {typeof v === 'number' ? (m.rate ? pct(v) : money(v)) : '–'}
                          {Math.abs(d) > 0.005 && (
                            <div class="muted" style={{ fontSize: 11 }}>
                              {d > 0 ? '+' : '−'}
                              {m.rate ? pct(Math.abs(d)) : money(Math.abs(d))}
                              {!m.rate && typeof b === 'number' && b !== 0 ? ` (${pct(d / Math.abs(b))})` : ''}
                            </div>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="card">
            <h2>Cost by family</h2>
            <div class="legend" style={{ marginBottom: 10 }}>
              {bars.map((f, i) => (
                <span>
                  <span class="swatch" style={{ background: colorOf(i, f) }} />
                  {f === 'other' ? `other (${folded.length})` : f}
                </span>
              ))}
            </div>
            {fam.map(({ name, m }, row) => {
              const total = results[row]!.r.total
              return (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '180px 1fr 90px',
                    gap: 8,
                    alignItems: 'center',
                    marginBottom: 6,
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                  <div class="splitbar" style={{ height: 18, width: `${(total / maxTotal) * 100}%` }}>
                    {bars.map((f, i) => {
                      const v = valueOf(m, f)
                      return v > 0 ? (
                        <div
                          style={{ flex: v, background: colorOf(i, f) }}
                          title={`${name} · ${f}: ${money(v)} (${pct(v / total)})`}
                        />
                      ) : null
                    })}
                  </div>
                  <span class="num">{moneyShort(total)}</span>
                </div>
              )
            })}
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>family</th>
                  {results.map(({ name }) => (
                    <th class="num">{name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {families.map((f) => (
                  <tr>
                    <td>{f}</td>
                    {fam.map(({ m }) => (
                      <td class="num">{m.has(f) ? money(m.get(f)!) : '–'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
