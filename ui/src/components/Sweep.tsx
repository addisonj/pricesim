// One-variable sweep (as `pm sweep`), on top of the scenario's current overrides: total cost against the
// variable, optional used/idle/fixed, top dimensions, revenue and margin; pool counts on their own chart.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { range, sweepCsv, type SweepRow } from 'pricesim'
import { KIND_COLORS, slotColor } from '../model/colors.ts'
import { moneyShort, num, quantity } from '../model/format.ts'
import type { InputSpec } from '../model/inputs.ts'
import { runSweep, type Evaluator, type SweepPoint } from '../model/run.ts'
import { LineChart, type LineSeries } from './LineChart.tsx'
import type { Entry } from './Simulator.tsx'

const TOP_DIMS = 5
const count = (v: number) => num(v)
/** dimension series skip the slots used by used (1), revenue/margin (6) and fixed (7) */
const dimColor = (i: number) => slotColor([1, 2, 3, 4, 7][i] ?? 8)

const toRow = (key: string, p: SweepPoint): SweepRow | undefined => {
  if (!p.outcome.ok) return undefined
  const r = p.outcome.result
  return {
    inputs: { [key]: p.x },
    total: r.total,
    used: r.used,
    idle: r.idle,
    fixed: r.fixed,
    dimensions: Object.fromEntries(r.dimensions.map((d) => [d.id, d.cost])),
    pools: Object.fromEntries(r.pools.map((p) => [p.name, p.count])),
  }
}

const Check = (props: { label: string; color?: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label>
    <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
    {props.color && <span class="swatch" style={{ background: props.color }} />}
    {props.label}
  </label>
)

export const Sweep = (props: { evaluator: Evaluator; entry: Entry; inputs: readonly InputSpec[] }) => {
  const { evaluator, entry, inputs } = props
  const { scenario, overrides } = entry
  const [key, setKey] = useState(inputs[0]?.key ?? '')
  const spec = inputs.find((i) => i.key === key)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [n, setN] = useState(20)
  const [log, setLog] = useState(true)
  const [points, setPoints] = useState<readonly SweepPoint[]>([])
  const [running, setRunning] = useState(false)
  const [shown, setShown] = useState<Record<string, boolean>>({ used: true, idle: true, fixed: false, margin: true })
  const abort = useRef<AbortController>()

  // default range: a decade either side of the current value
  useEffect(() => {
    if (!spec) return
    const v = overrides[spec.key] ?? spec.base
    const lo = spec.log ? Math.max(spec.min, v / 10) : spec.min
    const hi = spec.log ? Math.min(spec.max, v * 10) : spec.max
    setFrom(String(Number(lo.toPrecision(3))))
    setTo(String(Number(hi.toPrecision(3))))
    setLog(spec.log)
  }, [key, scenario])
  useEffect(() => () => abort.current?.abort(), [])

  const start = async () => {
    abort.current?.abort()
    const a = Number(from)
    const b = Number(to)
    if (!spec || !Number.isFinite(a) || !Number.isFinite(b)) return
    const ctl = new AbortController()
    abort.current = ctl
    setRunning(true)
    setPoints([])
    try {
      const values = range(a, b, Math.max(2, n), { log: log && a > 0 && b > 0 })
      await runSweep(evaluator, entry, overrides, key, values, setPoints, ctl.signal)
    } finally {
      if (abort.current === ctl) setRunning(false)
    }
  }

  const ok = points.filter((p) => p.outcome.ok)
  const errors = points.length - ok.length
  const firstError = points.map((p) => p.outcome).find((o) => !o.ok)
  const priced = ok.some((p) => p.outcome.ok && p.outcome.result.revenue)
  const at = <T,>(f: (r: Extract<SweepPoint['outcome'], { ok: true }>['result']) => T) =>
    points.map((p) => (p.outcome.ok ? f(p.outcome.result) : null))

  const topDims = useMemo(() => {
    const max = new Map<string, number>()
    for (const p of points)
      if (p.outcome.ok) for (const d of p.outcome.result.dimensions) max.set(d.id, Math.max(max.get(d.id) ?? 0, d.cost))
    return [...max]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_DIMS)
      .map(([id]) => id)
  }, [points])
  const poolNames = useMemo(
    () => [...new Set(points.flatMap((p) => (p.outcome.ok ? p.outcome.result.pools.map((q) => q.name) : [])))],
    [points],
  )

  const x = useMemo(() => points.map((p) => p.x), [points])
  const costSeries = useMemo(() => {
    const s: LineSeries[] = [{ label: 'total', color: 'var(--text-primary)', values: at((r) => r.total) }]
    if (shown.used) s.push({ label: 'used', color: KIND_COLORS.used, values: at((r) => r.used) })
    if (shown.idle) s.push({ label: 'idle', color: KIND_COLORS.idle, values: at((r) => r.idle) })
    if (shown.fixed) s.push({ label: 'fixed', color: KIND_COLORS.fixed, values: at((r) => r.fixed) })
    topDims.forEach((id, i) => {
      if (shown[`dim:${id}`])
        s.push({
          label: id,
          color: dimColor(i),
          values: at((r) => r.dimensions.find((d) => d.id === id)?.cost ?? 0),
        })
    })
    if (priced && shown.revenue)
      s.push({ label: 'revenue', color: 'var(--series-6)', values: at((r) => r.revenue?.revenue ?? null) })
    if (priced && shown.margin)
      s.push({ label: 'margin', color: 'var(--series-6)', dash: true, values: at((r) => r.revenue?.margin ?? null) })
    return s
  }, [points, shown, topDims, priced])
  const poolSeries = useMemo(
    () =>
      poolNames
        .filter((p) => shown[`pool:${p}`])
        .map((p, i) => ({
          label: p,
          color: slotColor(i),
          values: at((r) => r.pools.find((q) => q.name === p)?.count ?? null),
        })),
    [points, shown, poolNames],
  )
  const formatX = useMemo(() => (v: number) => (spec ? quantity(v, spec.unit) : num(v)), [spec])
  const toggle = (k: string) => (v: boolean) => setShown((s) => ({ ...s, [k]: v }))

  const csv = () => {
    const rows = points.map((p) => toRow(key, p)).filter((r): r is SweepRow => !!r)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([sweepCsv(rows)], { type: 'text/csv' }))
    a.download = `${scenario.name}-sweep-${key.replace(/[^\w.-]/g, '_')}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (!inputs.length) return <div class="page muted">This scenario exposes no inputs to sweep.</div>
  return (
    <div class="page">
      <div class="card">
        <div class="form">
          <label>
            variable
            <select value={key} onChange={(e) => setKey(e.currentTarget.value)}>
              {inputs.map((i) => (
                <option value={i.key}>{i.key}</option>
              ))}
            </select>
          </label>
          <label>
            from <input type="text" value={from} onInput={(e) => setFrom(e.currentTarget.value)} />
          </label>
          <label>
            to <input type="text" value={to} onInput={(e) => setTo(e.currentTarget.value)} />
          </label>
          <label>
            points
            <input
              type="number"
              min={2}
              max={200}
              value={n}
              style={{ width: 70 }}
              onInput={(e) => setN(Number(e.currentTarget.value))}
            />
          </label>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={log} onChange={(e) => setLog(e.currentTarget.checked)} /> log spacing
          </label>
          <button class="primary" onClick={start}>
            {running ? 'Restart' : 'Run sweep'}
          </button>
          {running && <button onClick={() => abort.current?.abort()}>Stop</button>}
          {ok.length > 0 && !running && <button onClick={csv}>CSV</button>}
          <span class="muted">
            {spec && `unit: ${spec.unit || 'base units'}`}
            {points.length > 0 && ` · ${points.length} points${errors ? `, ${errors} failed` : ''}`}
            {Object.keys(overrides).length > 0 && ' · on top of the current input overrides'}
          </span>
        </div>
        {firstError && !firstError.ok && (
          <div class="error" style={{ marginTop: 8 }}>
            {firstError.error}
          </div>
        )}
      </div>
      {ok.length > 0 && (
        <>
          <div class="card">
            <h2>Cost / month vs {key}</h2>
            <div class="picker" style={{ marginBottom: 8 }}>
              {(['used', 'idle', 'fixed'] as const).map((k) => (
                <Check label={k} color={KIND_COLORS[k]} checked={!!shown[k]} onChange={toggle(k)} />
              ))}
              {priced && (
                <>
                  <Check
                    label="revenue"
                    color="var(--series-6)"
                    checked={!!shown.revenue}
                    onChange={toggle('revenue')}
                  />
                  <Check
                    label="margin (dashed)"
                    color="var(--series-6)"
                    checked={!!shown.margin}
                    onChange={toggle('margin')}
                  />
                </>
              )}
              {topDims.map((id, i) => (
                <Check label={id} color={dimColor(i)} checked={!!shown[`dim:${id}`]} onChange={toggle(`dim:${id}`)} />
              ))}
            </div>
            <LineChart x={x} xLabel={key} xLog={log} formatX={formatX} formatY={moneyShort} series={costSeries} />
          </div>
          {poolNames.length > 0 && (
            <div class="card">
              <h2>Pool counts vs {key}</h2>
              <div class="picker" style={{ marginBottom: 8 }}>
                {poolNames.map((p) => (
                  <Check label={p} checked={!!shown[`pool:${p}`]} onChange={toggle(`pool:${p}`)} />
                ))}
              </div>
              {poolSeries.length > 0 && (
                <LineChart
                  x={x}
                  xLabel={key}
                  xLog={log}
                  formatX={formatX}
                  formatY={count}
                  series={poolSeries}
                  height={220}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
