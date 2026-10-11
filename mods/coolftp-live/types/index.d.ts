export type OpStatus = 'running' | 'ok' | 'warn' | 'error'

export type Op = {
  id: string
  /** deploy, undo, verify, upload, ... */
  action: string
  /** mcp or cli */
  via: 'mcp' | 'cli'
  site?: string
  /** what it acted on: a path, "dry run", a deploy id */
  target?: string
  status: OpStatus
  startedAt: number
  endedAt?: number
  /** one line on the outcome */
  summary?: string
  url?: string
  /** true for ops restored from an earlier session */
  isEarlier?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'coolftp-live': { ops: Op[]; now: number }
  }
}
