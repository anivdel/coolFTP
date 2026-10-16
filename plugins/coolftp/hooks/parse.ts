import type { OpStatus, Place, Progress } from '../types'

/** The live file's name for a project folder: the same rule as coolFTP's MCP server (liveFileName). */
export const liveFileName = (cwd: string) =>
  cwd.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) + '.json'

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Reads the server's live file for a step that started at `since`. Undefined for a stale file
 * (an earlier step's), a finished one, or one that does not parse.
 */
export function progressOf(text: string, since: number): Progress | undefined {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || j.v !== 1 || j.finished === true || (num(j.startedAt) ?? 0) < since - 5000) return undefined
  const files = (Array.isArray(j.files) ? j.files : []) as Array<{ remote?: unknown; size?: unknown; transferred?: unknown }>
  /* The biggest file in flight is the one worth naming. */
  const main = [...files].sort((a, b) => (num(b.size) ?? 0) - (num(a.size) ?? 0))[0]
  const fileSize = num(main?.size)
  const fileBytes = num(main?.transferred)
  const bytes = num(j.bytes)
  const totalBytes = num(j.totalBytes)
  const fraction = totalBytes ? (bytes ?? 0) / totalBytes : fileSize ? (fileBytes ?? 0) / fileSize : undefined
  return {
    file: typeof main?.remote === 'string' ? main.remote : typeof j.last === 'string' && j.last ? j.last : undefined,
    fileBytes: main ? fileBytes : undefined,
    fileSize: main ? fileSize : undefined,
    alsoMoving: Math.max(0, files.length - 1),
    done: num(j.done) ?? 0,
    totalFiles: num(j.totalFiles),
    bytes,
    totalBytes,
    rate: num(j.rate),
    etaMs: num(j.etaMs),
    fraction: fraction === undefined ? undefined : Math.max(0, Math.min(1, fraction)),
  }
}

/** `mcp__coolftp__coolftp_deploy`, `mcp__plugin_x_coolftp__coolftp_undo`: the action, or undefined. */
export function mcpAction(tool: string): string | undefined {
  const m = /^mcp__.+__coolftp_([a-z]+)$/.exec(tool)
  return m ? m[1] : undefined
}

/** `coolftp deploy --dry-run`, `npx coolftp verify`: the subcommand, or undefined. */
export function cliAction(command: string): string | undefined {
  const m = /(?:^|[;&|(]\s*|\s)(?:npx\s+(?:-y\s+)?)?coolftp(?:\.exe)?\s+([a-z][a-z-]*)/.exec(command)
  return m ? m[1] : undefined
}

/** The JSON the coolFTP MCP server puts after its log lines, if it parses. */
export function resultJson(text: string): Record<string, unknown> | undefined {
  const starts = [text.startsWith('{') ? 0 : -1, text.lastIndexOf('\n\n{') + 2].filter(i => i >= 0 && text[i] === '{')
  for (const i of starts) {
    try {
      const v = JSON.parse(text.slice(i))
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {}
  }
  return undefined
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const firstLine = (text: string) =>
  (text.split('\n').find(l => l.trim() !== '') ?? '').trim().slice(0, 120)

const liveStatus = (live: unknown): OpStatus | undefined =>
  typeof live !== 'string'
    ? undefined
    : /^NOT/.test(live)
      ? 'error'
      : /but/.test(live)
        ? 'warn'
        : 'ok'

type Outcome = {
  status: OpStatus
  summary: string
  url?: string
  site?: string
  files?: number
  bytes?: number
  live?: 'live' | 'stale' | 'down'
  checks?: number
  isPreview?: boolean
  loadMs?: number
}

/** The first page timing a live check printed: `200 https://example.com/ (175ms)`. */
export function loadMsOf(text: string): number | undefined {
  const m = /^\s*\d{3} https?:\/\/\S+ \((\d+)ms\)/m.exec(text)
  return m ? Number(m[1]) : undefined
}

const verdict = (live: unknown): Outcome['live'] =>
  typeof live !== 'string' ? undefined : /^NOT/.test(live) ? 'down' : /but|old copy/.test(live) ? 'stale' : 'live'

/** Reads an MCP tool's text result into a status and one line. */
export function outcome(action: string, text: string, isError: boolean): Outcome {
  if (isError) return { status: 'error', summary: firstLine(text.replace(/^Error:\s*/, '')) }
  const j = resultJson(text)
  const warnings = text.split('\n').filter(l => /^(ERROR|WARNING|FAILED)/.test(l)).length
  if (!j) return { status: warnings ? 'warn' : 'ok', summary: firstLine(text) }

  const site = typeof j.site === 'string' ? j.site : undefined
  const urls = Array.isArray(j.urls) ? (j.urls as unknown[]) : []
  const url = typeof urls[0] === 'string' ? (urls[0] as string) : undefined

  if (action === 'deploy' || action === 'undo' || action === 'rollback' || action === 'diff') {
    const plan = j.plan as { counts?: { add: number; change: number; delete: number }; bytes?: number } | undefined
    const record = j.record as { duration?: string; bytes?: number } | undefined
    const c = plan?.counts
    const parts: string[] = []
    if (c) {
      const total = c.add + c.change + c.delete
      parts.push(total === 0 ? 'nothing to change' : `+${c.add} ~${c.change} −${c.delete}`)
    }
    const b = record?.bytes ?? plan?.bytes
    if (b) parts.push(bytes(b))
    if (record?.duration) parts.push(record.duration)
    if (j.dryRun === true || action === 'diff') parts.unshift('preview')
    const live = typeof j.live === 'string' ? j.live : undefined
    if (live) parts.push(/^NOT/.test(live) ? 'NOT verified' : /but/.test(live) ? 'live, some files stale' : 'live')
    const status = liveStatus(live) ?? (warnings ? 'warn' : 'ok')
    return {
      status,
      summary: parts.join(' · ') || firstLine(text),
      url,
      site,
      files: c ? c.add + c.change + c.delete : undefined,
      bytes: b || undefined,
      live: verdict(live),
      isPreview: j.dryRun === true || action === 'diff',
      loadMs: loadMsOf(text),
    }
  }

  if (action === 'verify') {
    const checks = Array.isArray(j.checks) ? (j.checks as Array<{ ok?: boolean }>) : []
    const passed = checks.filter(c => c.ok).length
    return {
      status: liveStatus(j.live) ?? 'ok',
      summary: `${String(j.live ?? 'checked')} · ${passed}/${checks.length} checks`,
      url: checkedUrl(text),
      live: verdict(j.live),
      checks: checks.length,
      loadMs: loadMsOf(text),
    }
  }

  return {
    status: warnings ? 'warn' : 'ok',
    summary: firstLine(text),
    site,
    files: typeof j.files === 'number' ? j.files : undefined,
    bytes: typeof j.bytes === 'number' ? j.bytes : undefined,
  }
}

/** The site a coolftp_status answer says the folder deploys to. */
export function placeOf(status: Record<string, unknown> | undefined): Place | undefined {
  if (!status) return undefined
  const site = status.site as { name?: unknown; host?: unknown } | undefined
  const config = status.config as { site?: unknown; url?: unknown } | null | undefined
  const name = typeof site?.name === 'string' ? site.name : typeof config?.site === 'string' && config.site ? config.site : undefined
  if (!name) return undefined
  /* The project's own url (.coolftp.json) wins over the saved site's, as it does for live checks. */
  const own = typeof config?.url === 'string' ? /^https?:\/\/([^/:]+)/.exec(config.url)?.[1] : undefined
  return { site: name, host: typeof site?.host === 'string' && site.host ? site.host : own }
}

/** The first address a live check opened: `Checking https://example.com and 2 files`. */
export function checkedUrl(text: string): string | undefined {
  const m = /^Checking (https?:\/\/\S+)/m.exec(text) ?? /^\s*\d{3} (https?:\/\/\S+) \(/m.exec(text)
  return m ? m[1] : undefined
}

/** What an MCP call acted on, from its arguments. */
export function targetOf(action: string, args: Record<string, unknown>): string | undefined {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
  if (args.dryRun === true) return 'dry run'
  if (action === 'rename') return s('from') && s('to') ? `${s('from')} → ${s('to')}` : undefined
  if (action === 'upload') return s('local')
  if (action === 'download') return s('remote')
  if (action === 'undo' || action === 'rollback') return s('to')
  if (action === 'deploy') return s('message')
  return s('path')
}

export function clock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** Present tense for the status line. */
export function doing(action: string): string {
  const words: Record<string, string> = {
    deploy: 'deploying',
    undo: 'undoing the last deploy',
    rollback: 'rolling back',
    verify: 'checking the live site',
    upload: 'uploading',
    download: 'downloading',
    diff: 'comparing with the server',
    delete: 'deleting',
    write: 'writing',
    read: 'reading',
    ls: 'listing',
    mkdir: 'creating a folder',
    rename: 'renaming',
  }
  return words[action] ?? action
}
