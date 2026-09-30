// Worker side of `workerEvaluator`: evaluate scenarios by name, off the main thread.
//
//   // my-scenarios.worker.ts
//   import { serveScenarios } from 'pricesim-ui/worker'
//   import { scenarios } from './my-scenarios.ts'
//   serveScenarios(scenarios)
import type { Scenario } from 'pricesim'
import { run, type Outcome, type WorkerRequest } from './model/run.ts'

export const serveScenarios = (scenarios: Readonly<Record<string, Scenario>>): void => {
  self.addEventListener('message', (e: MessageEvent<WorkerRequest>) => {
    const { source, overrides } = e.data
    const s = scenarios[source]
    const outcome: Outcome = s ? run(s, overrides) : { ok: false, error: `worker: no scenario '${source}'`, ms: 0 }
    self.postMessage(outcome)
  })
}
