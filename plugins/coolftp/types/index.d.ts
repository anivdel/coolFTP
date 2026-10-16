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
  /** while files move: what the coolFTP MCP server last wrote to its live file */
  progress?: Progress
}

/** A transfer in flight, as the panel draws it. */
export type Progress = {
  /** the file moving now, its remote path */
  file?: string
  fileBytes?: number
  fileSize?: number
  /** other files moving at the same time */
  alsoMoving: number
  /** files finished so far, and of how many when the job knows */
  done: number
  totalFiles?: number
  bytes?: number
  totalBytes?: number
  /** bytes per second */
  rate?: number
  etaMs?: number
  /** 0..1 when there is a total to measure against */
  fraction?: number
}

/** The site a project folder deploys to: its coolFTP name and the domain people know it by. */
export type Place = { site?: string; host?: string }

declare module 'claude-code' {
  interface PluginState {
    'coolftp': { ops: Op[]; now: number; where: Record<string, Place> }
  }
}
