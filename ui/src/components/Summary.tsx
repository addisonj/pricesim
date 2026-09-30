// Headline numbers: total and its used / idle / fixed split, and revenue and margin when priced.
import type { Result } from 'pricesim'
import { KIND_COLORS } from '../model/colors.ts'
import { money, pct } from '../model/format.ts'

const Tile = (props: { label: string; value: string; sub?: string; color?: string; tone?: 'good' | 'bad' }) => (
  <div class="tile">
    <div class="label">
      {props.color && <span class="swatch" style={{ background: props.color }} />}
      {props.label}
    </div>
    <div class={`value ${props.tone ?? ''}`}>{props.value}</div>
    {props.sub && <div class="sub">{props.sub}</div>}
  </div>
)

export const Summary = ({ result: r, baseline }: { result: Result; baseline?: Result }) => {
  const delta = baseline && Math.abs(r.total - baseline.total) > 0.005 ? r.total - baseline.total : 0
  const share = (v: number) => (r.total > 0 ? `${pct(v / r.total)} of total` : undefined)
  const rev = r.revenue
  return (
    <div class="tiles">
      <div class="tile">
        <div class="label">Total cost / month</div>
        <div class="value">{money(r.total)}</div>
        <div class="sub">
          {delta ? (
            <span class={delta > 0 ? 'bad' : 'good'}>
              {delta > 0 ? '+' : '−'}
              {money(Math.abs(delta))} ({pct(delta / baseline!.total)}) vs scenario
            </span>
          ) : (
            `${r.region} · ${r.period.hours} h`
          )}
        </div>
        <div class="splitbar" aria-hidden>
          {(['used', 'idle', 'fixed'] as const).map((k) =>
            r[k] > 0 ? <div style={{ flex: r[k], background: KIND_COLORS[k] }} title={`${k}: ${money(r[k])}`} /> : null,
          )}
        </div>
      </div>
      <Tile label="Used" value={money(r.used)} sub={share(r.used)} color={KIND_COLORS.used} />
      <Tile label="Idle" value={money(r.idle)} sub={share(r.idle)} color={KIND_COLORS.idle} />
      <Tile label="Fixed" value={money(r.fixed)} sub={share(r.fixed)} color={KIND_COLORS.fixed} />
      {rev && (
        <>
          <Tile label="Revenue / month" value={money(rev.revenue)} sub={rev.priceBook} />
          <Tile
            label="Margin"
            value={money(rev.margin)}
            sub={`${pct(rev.marginRate)} of revenue · provider cost ${money(rev.cost)}`}
            tone={rev.margin < 0 ? 'bad' : 'good'}
          />
        </>
      )}
    </div>
  )
}
