import type { OpStatus } from '../types'

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
    }
  }

  if (action === 'verify') {
    const checks = Array.isArray(j.checks) ? (j.checks as Array<{ ok?: boolean }>) : []
    const passed = checks.filter(c => c.ok).length
    return {
      status: liveStatus(j.live) ?? 'ok',
      summary: `${String(j.live ?? 'checked')} · ${passed}/${checks.length} checks`,
      live: verdict(j.live),
      checks: checks.length,
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
