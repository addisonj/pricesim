// Evaluation worker for the dev app: the same scenarios, evaluated off the main thread.
import { serveScenarios } from '../src/worker.ts'
import { scenarios } from './scenarios.ts'

serveScenarios(scenarios)
