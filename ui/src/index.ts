// Public entry point: mount the simulator into any element with your own scenarios.
//
//   import { mountSimulator } from 'pricesim-ui'
//   const sim = mountSimulator(document.getElementById('app')!, { scenarios: { typical, peak } })
//   sim.update({ scenarios: { typical, peak, next } })   // e.g. after hot reload
//   sim.unmount()
import { h, render } from 'preact'
import { Simulator, type SimulatorProps } from './components/Simulator.tsx'

export type SimulatorOptions = SimulatorProps

export interface SimulatorHandle {
  /** re-render with new options; overrides persist for scenarios whose names persist */
  update(options: SimulatorOptions): void
  unmount(): void
}

export const mountSimulator = (element: Element, options: SimulatorOptions): SimulatorHandle => {
  render(h(Simulator, options), element)
  return {
    update: (next) => render(h(Simulator, next), element),
    unmount: () => render(null, element),
  }
}

export { Simulator } from './components/Simulator.tsx'
export type { Entry } from './components/Simulator.tsx'
export { applyOverrides, discoverInputs, type InputSpec, type Overrides } from './model/inputs.ts'
export { run, runSweep, type Outcome, type SweepPoint } from './model/run.ts'
