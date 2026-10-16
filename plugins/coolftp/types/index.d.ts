export type OpStatus = 'running' | 'ok' | 'warn' | 'error'

export type Op = {
  id: string
  /** deploy, undo, verify, upload, ... */
  action: string
  /** mcp or cli */
  via: 'mcp' | 'cli'
  /** the project folder the step ran for */
  cwd?: string
  /** the site it went to: its domain when known, else its coolFTP name */
  site?: string
  /** what it acted on: a path, "dry run", a deploy id */
  target?: string
  status: OpStatus
  startedAt: number
  endedAt?: number
  /** one line on the outcome */
  summary?: string
  url?: string
  /** files the step sent, changed or would change */
  files?: number
  bytes?: number
  /** the live check's verdict, when the step ran one */
  live?: 'live' | 'stale' | 'down'
  /** a dry run or diff: nothing changed on the server */
  isPreview?: boolean
  /** pages a live check loaded */
  checks?: number
  /** how long the site's front page took to answer in the live check, ms */
  loadMs?: number
  /** the raw error, for plain words */
  error?: string
  /** true for ops restored from an earlier session */
  isEarlier?: boolean
}

/** The site a project folder deploys to: its coolFTP name and the domain people know it by. */
export type Place = { site?: string; host?: string }

declare module 'claude-code' {
  interface PluginState {
    'coolftp': { ops: Op[]; now: number; where: Record<string, Place> }
  }
}
