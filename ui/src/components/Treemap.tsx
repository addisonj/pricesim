// The cost tree as a two-level treemap: the focused node's children as colored groups, their children inside.
// Click a group to zoom in; the breadcrumb zooms out.
import { useEffect, useRef, useState } from 'preact/hooks'
import type { CostNode } from 'pricesim'
import { usePalette } from '../model/colors.ts'
import { money, moneyShort, pct } from '../model/format.ts'
import { squarify, type Tile } from '../model/treemap.ts'

const HEIGHT = 360
const HEADER = 16

const keyOf = (n: CostNode) => `${n.kind}:${n.name}`

const find = (root: CostNode, path: readonly string[]): CostNode[] => {
  const trail = [root]
  for (const k of path) {
    const next = trail[trail.length - 1]!.children?.find((c) => keyOf(c) === k)
    if (!next) break
    trail.push(next)
  }
  return trail
}

const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(200, Math.floor(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, width }
}

const fits = (t: { w: number; h: number }, text: string) => t.w > text.length * 6.2 + 8 && t.h > 16

export const Treemap = ({ tree }: { tree: CostNode }) => {
  const [path, setPath] = useState<string[]>([])
  const [hover, setHover] = useState<CostNode | undefined>(undefined)
  const { ref, width } = useWidth()
  const color = usePalette()
  const trail = find(tree, path)
  const focus = trail[trail.length - 1]!
  const groups = squarify(focus.children ?? [focus], (n) => n.cost, { x: 0, y: 0, w: width, h: HEIGHT })
  const describe = (n: CostNode) => `${n.name} (${n.kind}): ${money(n.cost)}, ${pct(n.share)} of total`

  const inner = (g: Tile<CostNode>) => {
    if (!g.item.children || g.w < 40 || g.h < HEADER + 20) return []
    return squarify(g.item.children, (n) => n.cost, { x: g.x + 2, y: g.y + HEADER, w: g.w - 4, h: g.h - HEADER - 2 })
  }

  return (
    <div class="card treemap">
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2>Treemap</h2>
        <span class="crumbs">
          {trail.map((n, i) => (
            <>
              {i > 0 && <span class="muted">›</span>}
              <button disabled={i === trail.length - 1} onClick={() => setPath(path.slice(0, i))}>
                {n.name}
              </button>
            </>
          ))}
        </span>
        <span class="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
          {hover ? describe(hover) : 'click a group to zoom in'}
        </span>
      </div>
      <div ref={ref}>
        <svg width={width} height={HEIGHT} role="img" aria-label={`treemap of ${focus.name}`}>
          {groups.map((g) => {
            const fill = color(keyOf(g.item))
            const kids = inner(g)
            const label = `${g.item.name} ${moneyShort(g.item.cost)}`
            const zoomable = !!g.item.children?.length
            return (
              <g
                onClick={() => zoomable && setPath([...path, keyOf(g.item)])}
                onMouseLeave={() => setHover(undefined)}
                style={{ cursor: zoomable ? 'pointer' : 'default' }}
              >
                <rect
                  class="tile"
                  x={g.x}
                  y={g.y}
                  width={g.w}
                  height={g.h}
                  fill={fill}
                  fill-opacity={kids.length ? 0.55 : 0.9}
                  onMouseEnter={() => setHover(g.item)}
                >
                  <title>{describe(g.item)}</title>
                </rect>
                {kids.map((k) => (
                  <>
                    <rect
                      class="tile"
                      x={k.x}
                      y={k.y}
                      width={k.w}
                      height={k.h}
                      fill={fill}
                      fill-opacity={0.9}
                      stroke-width={1}
                      onMouseEnter={() => setHover(k.item)}
                    >
                      <title>{describe(k.item)}</title>
                    </rect>
                    {fits(k, k.item.name) && (
                      <text x={k.x + 4} y={k.y + 13}>
                        {k.item.name}
                      </text>
                    )}
                  </>
                ))}
                {fits(g, label) ? (
                  <text class="group" x={g.x + 4} y={g.y + 12}>
                    {label}
                  </text>
                ) : (
                  fits(g, g.item.name) && (
                    <text class="group" x={g.x + 4} y={g.y + 12}>
                      {g.item.name}
                    </text>
                  )
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
