// Svg widget sources for Desktop / VS Code. Each returns a complete <svg> string.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function bar(fraction: number, color: string, track = '#30363d', width = 240, height = 8): string {
  const w = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="${height / 2}" fill="${track}"/>` +
    `<rect width="${w}" height="${height}" rx="${height / 2}" fill="${color}"/></svg>`
  )
}

export type Lane = { label: string; start: number; end: number; color: string; outline?: string }

// Swimlanes over [from, to]: one row per lane, label left, bar right, a "now" edge.
export function gantt(lanes: readonly Lane[], from: number, to: number, width = 300, labelWidth = 96): string {
  const row = 16
  const height = Math.max(row, lanes.length * row)
  const span = Math.max(1, to - from)
  const plot = width - labelWidth
  const font = 'font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="11"'
  const label = (t: string) => (t.length > 15 ? `${t.slice(0, 14)}…` : t)
  const parts = lanes.map((lane, i) => {
    const x = labelWidth + ((Math.max(lane.start, from) - from) / span) * plot
    const w = Math.max(3, ((Math.min(lane.end, to) - Math.max(lane.start, from)) / span) * plot)
    const y = i * row
    const stroke = lane.outline ? ` stroke="${lane.outline}" stroke-width="1.5"` : ''
    return (
      `<text x="0" y="${y + 11.5}" ${font} fill="#8b949e">${esc(label(lane.label))}</text>` +
      `<rect x="${labelWidth}" y="${y + 7}" width="${plot}" height="1" fill="#30363d"/>` +
      `<rect x="${x.toFixed(1)}" y="${y + 3}" width="${w.toFixed(1)}" height="${row - 6}" rx="2" fill="${lane.color}"${stroke}/>`
    )
  })
  const nowLine = `<rect x="${width - 1}" y="0" width="1" height="${height}" fill="#8b949e" opacity="0.5"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}${nowLine}</svg>`
}

export function sparkline(values: readonly number[], color: string, width = 160, height = 24, fixedMax?: number): string {
  if (values.length < 2) return bar(0, color, '#30363d', width, 4)
  const max = fixedMax ?? Math.max(...values, 1)
  const step = width / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`
  )
}

export function donut(fraction: number, color: string, track = '#30363d', size = 48): string {
  const r = size / 2 - 5
  const c = 2 * Math.PI * r
  const f = Math.max(0, Math.min(1, fraction))
  const cx = size / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${track}" stroke-width="6"/>` +
    `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${color}" stroke-width="6" ` +
    `stroke-dasharray="${(f * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cx})"/>` +
    `<text x="${cx}" y="${cx + 4}" text-anchor="middle" font-size="11" fill="#8b949e" font-family="sans-serif">${Math.round(f * 100)}%</text></svg>`
  )
}

// Heat strip: one square per recent call, coloured by outcome.
export function heatStrip(colors: readonly string[], cell = 10, gap = 2): string {
  const width = Math.max(cell, colors.length * (cell + gap))
  const rects = colors.map((c, i) => `<rect x="${i * (cell + gap)}" y="0" width="${cell}" height="${cell}" rx="2" fill="${c}"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${cell}" viewBox="0 0 ${width} ${cell}">${rects.join('')}</svg>`
}
