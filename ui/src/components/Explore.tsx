// One scenario: inputs on the left, its live result on the right.
import { roundResult } from 'pricesim'
import type { InputSpec, Overrides } from '../model/inputs.ts'
import { useEvaluation, type Evaluator } from '../model/run.ts'
import { Controls } from './Controls.tsx'
import { CostTree } from './CostTree.tsx'
import { Dimensions, Pools, Revenue, Tenants } from './Details.tsx'
import type { Entry } from './Simulator.tsx'
import { Summary } from './Summary.tsx'
import { Treemap } from './Treemap.tsx'

const download = (name: string, text: string, type: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

const NONE: Overrides = {}

export const Explore = (props: {
  evaluator: Evaluator
  entry: Entry
  inputs: readonly InputSpec[]
  onOverride: (key: string, v: number | undefined) => void
  onReset: () => void
}) => {
  const { evaluator, entry, inputs, onOverride, onReset } = props
  const { name, scenario, overrides } = entry
  const { outcome, pending } = useEvaluation(evaluator, entry, overrides, { channel: 'explore' })
  // the scenario's own result, for deltas
  const baseline = useEvaluation(evaluator, entry, NONE, { delay: 0, channel: 'baseline' }).outcome
  const r = outcome?.ok ? outcome.result : undefined
  return (
    <div class="explore">
      <aside class="sidebar">
        <Controls inputs={inputs} overrides={overrides} onChange={onOverride} onReset={onReset} />
      </aside>
      <section class="main">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{name}</h2>
          {scenario.description && <span class="secondary">{scenario.description}</span>}
          <span class="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            {pending ? 'evaluating…' : outcome ? `evaluated in ${outcome.ms.toFixed(0)} ms` : ''}
          </span>
          {r && (
            <button
              onClick={() =>
                download(`${r.scenario}.json`, JSON.stringify(roundResult(r), null, 2) + '\n', 'application/json')
              }
            >
              JSON
            </button>
          )}
        </div>
        {outcome && !outcome.ok && <div class="card error">Evaluation failed: {outcome.error}</div>}
        {r && (
          <>
            <Summary result={r} {...(baseline?.ok ? { baseline: baseline.result } : {})} />
            <div class="row2">
              <CostTree tree={r.tree} />
              <Treemap tree={r.tree} />
            </div>
            <Revenue result={r} />
            <Pools pools={r.pools} />
            <Tenants result={r} />
            <Dimensions result={r} />
          </>
        )}
      </section>
    </div>
  )
}
