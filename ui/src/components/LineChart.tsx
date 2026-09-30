// A thin uPlot wrapper: one x series, several y series on one axis, crosshair + legend values on hover.
import { useEffect, useRef } from 'preact/hooks'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

export interface LineSeries {
  readonly label: string
  readonly color: string
  readonly values: readonly (number | null)[]
  readonly dash?: boolean
}

/** uPlot draws on canvas, so CSS custom properties are resolved to concrete colors first */
const resolve = (el: Element, color: string): string => {
  const m = /^var\((--[\w-]+)\)$/.exec(color)
  return m ? getComputedStyle(el).getPropertyValue(m[1]!).trim() || '#888' : color
}

export const LineChart = (props: {
  x: readonly number[]
  xLabel: string
  xLog: boolean
  formatX: (v: number) => string
  formatY: (v: number) => string
  series: readonly LineSeries[]
  height?: number
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const { x, xLabel, xLog, formatX, formatY, series, height = 320 } = props
  useEffect(() => {
    const el = ref.current
    if (!el || !x.length) return
    const axisColor = resolve(el, 'var(--text-secondary)')
    const gridColor = resolve(el, 'var(--border)')
    const axis = { stroke: axisColor, grid: { stroke: gridColor, width: 1 }, ticks: { stroke: gridColor, width: 1 } }
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height,
      // the x range is the swept range, not rounded out to whole decades
      scales: { x: { time: false, distr: xLog ? 3 : 1, range: (_u, min, max) => [min, max] } },
      axes: [
        { ...axis, label: xLabel, values: (_u, vals) => vals.map((v) => (v === null ? '' : formatX(v))) },
        { ...axis, size: 70, values: (_u, vals) => vals.map((v) => (v === null ? '' : formatY(v))) },
      ],
      series: [
        { label: xLabel, value: (_u, v) => (v === null ? '–' : formatX(v)) },
        ...series.map((s) => ({
          label: s.label,
          stroke: resolve(el, s.color),
          width: 2,
          ...(s.dash ? { dash: [6, 4] } : {}),
          points: { size: 6 },
          value: (_u: uPlot, v: number | null) => (v === null ? '–' : formatY(v)),
        })),
      ],
      cursor: { points: { size: 8 } },
    }
    const data = [x as number[], ...series.map((s) => s.values as (number | null)[])] as uPlot.AlignedData
    const plot = new uPlot(opts, data, el)
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }))
    ro.observe(el)
    return () => {
      ro.disconnect()
      plot.destroy()
    }
  }, [x, xLabel, xLog, formatX, formatY, series, height])
  return <div class="chart" ref={ref} />
}
