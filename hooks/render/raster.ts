// Raster cell grids for the terminal. Cells are packed per RasterProps:
// base64 of little-endian u32 triplets [codePoint, foreground, background].

export const DEFAULT_COLOR = 0x01000000

export type Cell = { ch: string; fg: number; bg?: number }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 63]
  }
  return out
}

export function cellsOf(cells: readonly Cell[]): string {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach((cell, i) => {
    words[i * 3] = cell.ch.codePointAt(0) ?? 0x20
    words[i * 3 + 1] = cell.fg
    words[i * 3 + 2] = cell.bg ?? DEFAULT_COLOR
  })
  // Uint32Array is platform-endian; force little-endian.
  const bytes = new Uint8Array(words.length * 4)
  const view = new DataView(bytes.buffer)
  words.forEach((w, i) => view.setUint32(i * 4, w, true))
  return base64(bytes)
}

export type Grid = { columns: number; rows: number; cells: string }

export function bar(fraction: number, width: number, fg: number, track: number): Grid {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  const cells: Cell[] = []
  for (let i = 0; i < width; i++) cells.push(i < filled ? { ch: '█', fg } : { ch: '░', fg: track })
  return { columns: width, rows: 1, cells: cellsOf(cells) }
}

export function heatStrip(colors: readonly number[]): Grid {
  const cells = colors.map(fg => ({ ch: '■', fg }))
  return { columns: Math.max(1, cells.length), rows: 1, cells: cellsOf(cells.length ? cells : [{ ch: ' ', fg: DEFAULT_COLOR }]) }
}

const SPARK = '▁▂▃▄▅▆▇█'

export function sparkline(values: readonly number[], fg: number): Grid {
  const max = Math.max(...values, 1)
  const cells = values.map(v => ({ ch: SPARK[Math.min(7, Math.floor((v / max) * 7.999))]!, fg }))
  return { columns: Math.max(1, cells.length), rows: 1, cells: cellsOf(cells.length ? cells : [{ ch: ' ', fg }]) }
}

export type Lane = { start: number; end: number; fg: number }

// One row per lane, `width` cells spanning [from, to].
export function swimlanes(lanes: readonly Lane[], from: number, to: number, width: number, track: number): Grid {
  const span = Math.max(1, to - from)
  const cells: Cell[] = []
  for (const lane of lanes) {
    const a = Math.floor(((Math.max(lane.start, from) - from) / span) * width)
    const b = Math.max(a + 1, Math.ceil(((Math.min(lane.end, to) - from) / span) * width))
    for (let x = 0; x < width; x++) cells.push(x >= a && x < b ? { ch: '▆', fg: lane.fg } : { ch: '·', fg: track })
  }
  return { columns: width, rows: Math.max(1, lanes.length), cells: cellsOf(cells) }
}
