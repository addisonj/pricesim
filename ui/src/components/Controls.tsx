// Inputs generated from the scenario's workload: a slider (log scale for rates and sizes) plus a text box for
// exact values, which accepts base units ("500000") or a quantity with a unit ("500 KB", "20 req/s").
import { useEffect, useMemo, useState } from 'preact/hooks'
import { parseQuantity } from 'pricesim'
import { quantity } from '../model/format.ts'
import { ALL_TENANTS, type InputGroup, type InputSpec, type Overrides } from '../model/inputs.ts'

const GROUPS: Record<InputGroup, string> = {
  rates: 'Request rates',
  attrs: 'Request attributes',
  gauges: 'Gauges',
  params: 'Params',
}

const STEPS = 1000

const toSlider = (spec: InputSpec, v: number): number => {
  const c = Math.min(spec.max, Math.max(spec.min, v))
  const f = spec.log
    ? (Math.log(c) - Math.log(spec.min)) / (Math.log(spec.max) - Math.log(spec.min))
    : (c - spec.min) / (spec.max - spec.min || 1)
  return Math.round(f * STEPS)
}

/** 3 significant digits keeps slider values readable */
const round3 = (v: number) => (v === 0 ? 0 : Number(v.toPrecision(3)))

const fromSlider = (spec: InputSpec, p: number): number => {
  const f = p / STEPS
  const v = spec.log
    ? Math.exp(Math.log(spec.min) + f * (Math.log(spec.max) - Math.log(spec.min)))
    : spec.min + f * (spec.max - spec.min)
  return round3(v)
}

/** a number in base units, or a quantity such as '500 KB' converted to base units */
const parseValue = (text: string): number | undefined => {
  const t = text.trim().replace(/,/g, '')
  if (!t) return undefined
  const n = Number(t)
  if (Number.isFinite(n)) return n
  try {
    const v = parseQuantity(t).eval()
    return Number.isFinite(v) ? v : undefined
  } catch {
    return undefined
  }
}

const Control = (props: { spec: InputSpec; value: number; onChange: (v: number | undefined) => void }) => {
  const { spec, value, onChange } = props
  const changed = value !== spec.base
  const [text, setText] = useState(String(round3(value)))
  useEffect(() => setText(String(Number(value.toPrecision(6)))), [value])
  const commit = () => {
    const v = parseValue(text)
    if (v === undefined) setText(String(Number(value.toPrecision(6))))
    else onChange(v)
  }
  return (
    <div class={`control${changed ? ' changed' : ''}`}>
      <div class="head">
        <span class="name" title={spec.key}>
          {spec.name}
        </span>
        {changed && (
          <button class="link" title={`reset to ${quantity(spec.base, spec.unit)}`} onClick={() => onChange(undefined)}>
            reset
          </button>
        )}
        <span class="val">{quantity(value, spec.unit)}</span>
      </div>
      <div class="inputs">
        <input
          type="range"
          min={0}
          max={STEPS}
          value={toSlider(spec, value)}
          aria-label={spec.key}
          onInput={(e) => onChange(fromSlider(spec, Number((e.target as HTMLInputElement).value)))}
        />
        <input
          type="text"
          value={text}
          aria-label={`${spec.key} exact value`}
          title={`base units${spec.unit ? ` (${spec.unit})` : ''}, or a quantity such as '500 KB'`}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
      </div>
      {(spec.note || changed) && (
        <div class="note">
          {changed && <>scenario: {quantity(spec.base, spec.unit)}. </>}
          {spec.note}
        </div>
      )}
    </div>
  )
}

export const Controls = (props: {
  inputs: readonly InputSpec[]
  overrides: Overrides
  onChange: (key: string, v: number | undefined) => void
  onReset: () => void
}) => {
  const { inputs, overrides, onChange, onReset } = props
  const tenants = useMemo(() => [...new Set(inputs.flatMap((i) => (i.tenant ? [i.tenant] : [])))], [inputs])
  const [tenant, setTenant] = useState<string>(ALL_TENANTS)
  const shown = inputs.filter((i) => !i.tenant || i.tenant === tenant)
  const count = Object.keys(overrides).length
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Inputs</h2>
        <span class="muted">{count ? `${count} changed` : 'scenario values'}</span>
        <button style={{ marginLeft: 'auto' }} disabled={!count} onClick={onReset}>
          Reset all
        </button>
      </div>
      {tenants.length > 0 && (
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
          Tenant
          <select value={tenant} onChange={(e) => setTenant((e.target as HTMLSelectElement).value)}>
            {tenants.map((t) => (
              <option value={t}>{t === ALL_TENANTS ? 'all tenants (scale)' : t}</option>
            ))}
          </select>
        </label>
      )}
      {(Object.keys(GROUPS) as InputGroup[]).map((g) => {
        const specs = shown.filter((i) => i.group === g)
        if (!specs.length) return null
        return (
          <div key={g}>
            <h3>{GROUPS[g]}</h3>
            {specs.map((spec) => (
              <Control
                key={spec.key}
                spec={spec}
                value={overrides[spec.key] ?? spec.base}
                onChange={(v) => onChange(spec.key, v)}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}
