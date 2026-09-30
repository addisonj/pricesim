// Dev app: the simulator over the repository's example scenarios. Append ?main-thread to the URL to evaluate
// without the worker.
import { mountSimulator } from '../src/index.ts'
import { scenarios } from './scenarios.ts'

const mainThread = new URLSearchParams(location.search).has('main-thread')

mountSimulator(document.getElementById('app')!, {
  title: 'pricesim simulator',
  scenarios,
  ...(mainThread ? {} : { worker: new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) }),
})
