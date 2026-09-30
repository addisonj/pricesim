// Evaluating scenarios from the UI: timed and error-safe, on the main thread or in a Web Worker.
//
// Scenarios hold closures (series, request handlers), so they cannot be posted to a worker. Instead the worker
// loads the same scenarios module itself (see ../worker.ts) and the UI sends it a scenario *name* plus the
// overrides; results are plain data and come back by structured clone.
import { useEffect, useState } from 'preact/hooks'
import { evaluate, type Result, type Scenario } from 'pricesim'
import { applyOverrides, type Overrides } from './inputs.ts'

export type Outcome =
  | { readonly ok: true; readonly result: Result; readonly ms: number }
  | { readonly ok: false; readonly error: string; readonly ms: number; readonly superseded?: true }

export const run = (s: Scenario, overrides: Overrides = {}): Outcome => {
  const t0 = performance.now()
  try {
    const result = evaluate(applyOverrides(s, overrides))
    return { ok: true, result, ms: performance.now() - t0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 }
  }
}

/** a scenario to evaluate: `source` names it for a worker, `scenario` is used on the main thread */
export interface Target {
  readonly source: string
  readonly scenario: Scenario
}

export interface Evaluator {
  /**
   * Evaluate with overrides. With a `channel`, a newer request on the same channel replaces one still waiting
   * in the queue (the replaced one resolves as superseded), so slider drags never build a backlog.
   */
  evaluate(target: Target, overrides: Overrides, channel?: string): Promise<Outcome>
}

const SUPERSEDED: Outcome = { ok: false, error: 'superseded', ms: 0, superseded: true }

/** Evaluate on the main thread, one macrotask later so the UI can paint 'evaluating…' first. */
export const mainThreadEvaluator = (): Evaluator => ({
  evaluate: (t, overrides) => new Promise((resolve) => setTimeout(() => resolve(run(t.scenario, overrides)), 0)),
})

export interface WorkerRequest {
  readonly source: string
  readonly overrides: Overrides
}

/** Evaluate in a worker running `serveScenarios` over the same scenario names; one request at a time. */
export const workerEvaluator = (worker: Worker): Evaluator => {
  interface Job extends WorkerRequest {
    readonly channel?: string
    readonly resolve: (o: Outcome) => void
  }
  const queue: Job[] = []
  let current: Job | undefined
  const next = () => {
    if (current || !queue.length) return
    current = queue.shift()!
    worker.postMessage({ source: current.source, overrides: current.overrides } satisfies WorkerRequest)
  }
  const settle = (o: Outcome) => {
    const job = current
    current = undefined
    job?.resolve(o)
    next()
  }
  worker.addEventListener('message', (e: MessageEvent<Outcome>) => settle(e.data))
  worker.addEventListener('error', (e) => settle({ ok: false, error: `worker: ${e.message}`, ms: 0 }))
  return {
    evaluate: (t, overrides, channel) =>
      new Promise((resolve) => {
        if (channel) {
          const i = queue.findIndex((j) => j.channel === channel)
          if (i >= 0) queue.splice(i, 1)[0]!.resolve(SUPERSEDED)
        }
        queue.push({ source: t.source, overrides, ...(channel ? { channel } : {}), resolve })
        next()
      }),
  }
}

/** Evaluate after `delay` ms without changes; keeps the last outcome on screen while the next one runs. */
export const useEvaluation = (
  evaluator: Evaluator,
  target: Target,
  overrides: Overrides,
  opts: { delay?: number; channel?: string } = {},
) => {
  const { delay = 120, channel } = opts
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined)
  const [pending, setPending] = useState(true)
  useEffect(() => {
    let live = true
    setPending(true)
    const t = setTimeout(async () => {
      const o = await evaluator.evaluate(target, overrides, channel)
      if (!live || (!o.ok && o.superseded)) return
      setOutcome(o)
      setPending(false)
    }, delay)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [evaluator, target.source, target.scenario, overrides, delay, channel])
  return { outcome, pending }
}

export interface SweepPoint {
  readonly x: number
  readonly outcome: Outcome
}

/** Evaluate at each value of one variable (on top of `overrides`), reporting progress; `signal` cancels. */
export const runSweep = async (
  evaluator: Evaluator,
  target: Target,
  overrides: Overrides,
  key: string,
  values: readonly number[],
  onProgress: (points: readonly SweepPoint[]) => void,
  signal: AbortSignal,
): Promise<SweepPoint[]> => {
  const points: SweepPoint[] = []
  let last = performance.now()
  for (const x of values) {
    if (signal.aborted) break
    points.push({ x, outcome: await evaluator.evaluate(target, { ...overrides, [key]: x }) })
    if (performance.now() - last > 100) {
      onProgress([...points])
      last = performance.now()
    }
  }
  if (!signal.aborted) onProgress([...points])
  return points
}
