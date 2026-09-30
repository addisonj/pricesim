// Squarified treemap layout (Bruls, Huizing, van Wijk 2000) over values sorted descending.

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface Tile<T> extends Rect {
  readonly item: T
}

/** worst aspect ratio of a row of areas laid along a side of length `side` */
const worst = (row: readonly number[], side: number): number => {
  const sum = row.reduce((a, v) => a + v, 0)
  const max = Math.max(...row)
  const min = Math.min(...row)
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
}

export const squarify = <T>(items: readonly T[], value: (t: T) => number, box: Rect): Tile<T>[] => {
  const total = items.reduce((a, t) => a + Math.max(0, value(t)), 0)
  if (total <= 0 || box.w <= 0 || box.h <= 0) return []
  const scale = (box.w * box.h) / total
  const queue = items
    .map((item) => ({ item, area: Math.max(0, value(item)) * scale }))
    .filter((e) => e.area > 0)
    .sort((a, b) => b.area - a.area)
  const tiles: Tile<T>[] = []
  let { x, y, w, h } = box
  let row: typeof queue = []
  const flush = () => {
    const sum = row.reduce((a, e) => a + e.area, 0)
    if (w >= h) {
      // lay the row as a column on the left
      const cw = sum / h
      let cy = y
      for (const e of row) {
        const eh = e.area / cw
        tiles.push({ item: e.item, x, y: cy, w: cw, h: eh })
        cy += eh
      }
      x += cw
      w -= cw
    } else {
      const rh = sum / w
      let cx = x
      for (const e of row) {
        const ew = e.area / rh
        tiles.push({ item: e.item, x: cx, y, w: ew, h: rh })
        cx += ew
      }
      y += rh
      h -= rh
    }
    row = []
  }
  for (const e of queue) {
    const side = Math.min(w, h)
    const areas = row.map((r) => r.area)
    if (row.length && worst([...areas, e.area], side) > worst(areas, side)) flush()
    row.push(e)
  }
  if (row.length) flush()
  return tiles
}
