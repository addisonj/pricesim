// The simulator: a scenario picker, and Explore / Compare / Sweep views over the registered scenarios.
import { useEffect, useMemo, useState } from 'preact/hooks'
import type { Scenario } from 'pricesim'
import { discoverInputs, type InputSpec, type Overrides } from '../model/inputs.ts'
import { mainThreadEvaluator, workerEvaluator } from '../model/run.ts'
import { Compare } from './Compare.tsx'
import { Explore } from './Explore.tsx'
import { Sweep } from './Sweep.tsx'
import '../styles.css'

export interface SimulatorProps {
  /** scenarios by display name */
  readonly scenarios: Readonly<Record<string, Scenario>>
  readonly title?: string
  /** the scenario shown first (default: the first) */
  readonly initial?: string
  /**
   * Evaluate in this worker instead of on the main thread. It must run `serveScenarios` (pricesim-ui/worker)
   * over the same scenario names. Recommended when an evaluation takes more than ~50 ms.
   */
  readonly worker?: Worker
}

/** a scenario under a display name, with the user's input overrides */
export interface Entry {
  readonly name: string
  /** the registered name of the scenario (differs from `name` for duplicates) */
  readonly source: string
  readonly scenario: Scenario
  readonly overrides: Overrides
}

type Tab = 'explore' | 'compare' | 'sweep'

// inputs only depend on the scenario object
const inputsCache = new WeakMap<Scenario, InputSpec[]>()
const inputsOf = (s: Scenario) => {
  let v = inputsCache.get(s)
  if (!v) inputsCache.set(s, (v = discoverInputs(s)))
  return v
}

const uniqueName = (taken: readonly string[], base: string) => {
  for (let i = 2; ; i++) if (!taken.includes(`${base} (${i})`)) return `${base} (${i})`
}

export const Simulator = ({ scenarios, title = 'pricesim simulator', initial, worker }: SimulatorProps) => {
  const evaluator = useMemo(() => (worker ? workerEvaluator(worker) : mainThreadEvaluator()), [worker])
  const [entries, setEntries] = useState<Entry[]>(() =>
    Object.entries(scenarios).map(([name, scenario]) => ({ name, source: name, scenario, overrides: {} })),
  )
  const [selected, setSelected] = useState(initial ?? Object.keys(scenarios)[0] ?? '')
  const [tab, setTab] = useState<Tab>('explore')

  // new or replaced scenarios from the host: keep overrides where the name persists
  useEffect(() => {
    setEntries((prev) => {
      const byName = new Map(prev.map((e) => [e.name, e]))
      const next: Entry[] = Object.entries(scenarios).map(([name, scenario]) => ({
        name,
        source: name,
        scenario,
        overrides: byName.get(name)?.overrides ?? {},
      }))
      const copies = prev.filter((e) => e.name !== e.source && scenarios[e.source])
      return [...next, ...copies.map((e) => ({ ...e, scenario: scenarios[e.source]! }))]
    })
  }, [scenarios])

  const entry = entries.find((e) => e.name === selected) ?? entries[0]
  const inputs = useMemo(() => (entry ? inputsOf(entry.scenario) : []), [entry?.scenario])
  if (!entry) return <div class="pm-sim page">No scenarios registered.</div>

  const setOverrides = (f: (o: Overrides) => Overrides) =>
    setEntries((es) => es.map((e) => (e.name === entry.name ? { ...e, overrides: f(e.overrides) } : e)))
  const onOverride = (key: string, v: number | undefined) =>
    setOverrides((o) => {
      const { [key]: _old, ...rest } = o
      const base = inputs.find((i) => i.key === key)?.base
      return v === undefined || v === base ? rest : { ...rest, [key]: v }
    })
  const duplicate = () => {
    const name = uniqueName(
      entries.map((e) => e.name),
      entry.source,
    )
    setEntries((es) => [...es, { ...entry, name }])
    setSelected(name)
  }
  const remove = () => {
    setEntries((es) => es.filter((e) => e.name !== entry.name))
    setSelected(entry.source)
  }

  return (
    <div class="pm-sim">
      <header class="topbar">
        <span class="title">{title}</span>
        <div class="tabs" role="tablist">
          {(['explore', 'compare', 'sweep'] as const).map((t) => (
            <button role="tab" class={tab === t ? 'active' : ''} aria-selected={tab === t} onClick={() => setTab(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {tab !== 'compare' && (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            Scenario
            <select value={entry.name} onChange={(e) => setSelected(e.currentTarget.value)}>
              {entries.map((e) => (
                <option value={e.name}>
                  {e.name}
                  {Object.keys(e.overrides).length ? ' •' : ''}
                </option>
              ))}
            </select>
            <button title="copy this scenario and its overrides, e.g. to compare variants" onClick={duplicate}>
              Duplicate
            </button>
            {entry.name !== entry.source && <button onClick={remove}>Remove</button>}
          </label>
        )}
        <span class="status muted">
          {entry.scenario.tenants ? `${entry.scenario.tenants.length} tenants · ` : ''}
          {entry.scenario.priceBook ? 'priced · ' : ''}
          {inputs.length} inputs
        </span>
      </header>
      {tab === 'explore' && (
        <Explore
          key={entry.name}
          evaluator={evaluator}
          entry={entry}
          inputs={inputs}
          onOverride={onOverride}
          onReset={() => setOverrides(() => ({}))}
        />
      )}
      {tab === 'compare' && <Compare evaluator={evaluator} entries={entries} />}
      {tab === 'sweep' && <Sweep key={entry.name} evaluator={evaluator} entry={entry} inputs={inputs} />}
    </div>
  )
}
