// Categorical colors (CSS custom properties from styles.css). Colors follow the entity, not its rank: a name
// keeps its slot for the life of the palette, and names past the eighth share the 'other' color.
import { useRef } from 'preact/hooks'

export const SLOTS = 8

export const slotColor = (i: number): string => (i < SLOTS ? `var(--series-${i + 1})` : 'var(--series-other)')

export const palette = () => {
  const slots = new Map<string, number>()
  return (name: string): string => {
    let i = slots.get(name)
    if (i === undefined) {
      i = slots.size
      slots.set(name, i)
    }
    return slotColor(i)
  }
}

/** a palette that persists across renders of a component */
export const usePalette = () => {
  const ref = useRef<ReturnType<typeof palette>>()
  ref.current ??= palette()
  return ref.current
}

export const KIND_COLORS = { used: 'var(--used)', idle: 'var(--idle)', fixed: 'var(--fixed)' } as const
