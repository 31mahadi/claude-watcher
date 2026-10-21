// Update notice: compare the installed version with the latest GitHub release. Pure; no `$`.

export const RELEASES_URL = 'https://api.github.com/repos/31mahadi/claude-watcher/releases/latest'
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
export const UPDATE_HINT = '/plugin marketplace update claude-watcher, then /plugin update watcher@claude-watcher'

const parts = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number)

// True when `latest` is a strictly higher x.y.z than `current`; anything unparsable is not newer.
export function isNewer(latest: string, current: string): boolean {
  const a = parts(latest)
  const b = parts(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

// The release tag from the GitHub API body, or undefined.
export function latestTag(body: string): string | undefined {
  try {
    const tag = (JSON.parse(body) as { tag_name?: unknown }).tag_name
    return typeof tag === 'string' ? tag : undefined
  } catch {
    return undefined
  }
}
