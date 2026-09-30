import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

const lib = (p: string) => fileURLToPath(new URL(`../src/${p}`, import.meta.url))

// The library is imported from source (../src), so the UI always runs against the current code. The aliases
// mirror pricesim's package.json `exports`, so examples written against 'pricesim/…' work as-is.
export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: [
      { find: /^pricesim$/, replacement: lib('index.ts') },
      { find: /^pricesim\/units$/, replacement: lib('core/units.ts') },
      { find: /^pricesim\/expr$/, replacement: lib('core/expr.ts') },
      { find: /^pricesim\/model$/, replacement: lib('model/index.ts') },
      { find: /^pricesim\/workload$/, replacement: lib('workload/index.ts') },
      { find: /^pricesim\/eval$/, replacement: lib('eval/index.ts') },
      { find: /^pricesim\/aws$/, replacement: lib('catalog/aws/index.ts') },
      { find: /^pricesim\/aws\/(.*)$/, replacement: lib('catalog/aws/$1.ts') },
    ],
    // the library's own dependency (mathjs) resolves from ui/node_modules, so the repo root needs no install
    dedupe: ['mathjs'],
  },
  server: { fs: { allow: ['..'] } },
  worker: { format: 'es' },
  // the bundle carries the generated AWS price catalog (~400 KB); splitting it buys nothing for a local tool
  build: { chunkSizeWarningLimit: 1500 },
})
