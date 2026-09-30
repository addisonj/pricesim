// The cost tree as a collapsible outline: cost, share of total, and usage at the dimension leaves.
import { useState } from 'preact/hooks'
import type { CostNode } from 'pricesim'
import { money, pct, quantity } from '../model/format.ts'

const idOf = (path: string, n: CostNode) => `${path}/${n.kind}:${n.name}`

const Row = (props: {
  node: CostNode
  path: string
  depth: number
  open: Set<string>
  toggle: (id: string) => void
}) => {
  const { node, path, depth, open, toggle } = props
  const id = idOf(path, node)
  const kids = node.children ?? []
  const isOpen = open.has(id)
  return (
    <>
      <div class="node" style={{ paddingLeft: 4 + depth * 14 }}>
        <span class="name" title={node.name}>
          <span class="toggle" onClick={() => kids.length && toggle(id)}>
            {kids.length ? (isOpen ? '▾' : '▸') : ''}
          </span>
          {node.name}
          <span class="kind">{node.kind}</span>
        </span>
        <span class="num muted">{node.usage !== undefined ? quantity(node.usage, node.unit ?? '') : ''}</span>
        <span class="num">{pct(node.share)}</span>
        <span class="num">{money(node.cost)}</span>
      </div>
      {isOpen && kids.map((c) => <Row node={c} path={id} depth={depth + 1} open={open} toggle={toggle} />)}
    </>
  )
}

/** ids of the nodes open by default: the first `depth` levels */
const initialOpen = (root: CostNode, depth: number): Set<string> => {
  const out = new Set<string>()
  const walk = (n: CostNode, path: string, d: number) => {
    if (d >= depth) return
    const id = idOf(path, n)
    out.add(id)
    for (const c of n.children ?? []) walk(c, id, d + 1)
  }
  walk(root, '', 0)
  return out
}

const allIds = (root: CostNode): Set<string> => {
  const out = new Set<string>()
  const walk = (n: CostNode, path: string) => {
    const id = idOf(path, n)
    if (n.children) out.add(id)
    for (const c of n.children ?? []) walk(c, id)
  }
  walk(root, '')
  return out
}

export const CostTree = ({ tree }: { tree: CostNode }) => {
  // open state is keyed by path, so it survives re-evaluation as inputs change
  const [open, setOpen] = useState(() => initialOpen(tree, 2))
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o)
      if (!n.delete(id)) n.add(id)
      return n
    })
  return (
    <div class="card">
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <h2>Cost tree</h2>
        <span style={{ marginLeft: 'auto' }}>
          <button class="link" onClick={() => setOpen(allIds(tree))}>
            expand all
          </button>
          <button class="link" onClick={() => setOpen(initialOpen(tree, 1))}>
            collapse
          </button>
        </span>
      </div>
      <div class="tree scroll">
        <Row node={tree} path="" depth={0} open={open} toggle={toggle} />
      </div>
    </div>
  )
}
