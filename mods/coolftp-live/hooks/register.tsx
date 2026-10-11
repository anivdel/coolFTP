import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Op, OpStatus } from '../types'
import { clock, cliAction, doing, elapsed, mcpAction, outcome, targetOf } from './parse'

const PANE = 'coolftp-live'
const TITLE = 'coolFTP'
const KEEP = 40
const STORE_KEY = 'recent'

/** coolFTP blues; status colors come from the person's theme. */
const BLUE = '#4FA3FF'
const DEEP = '#2B6CB0'

/** Calls that change the server: these toast when they finish. */
const LOUD = new Set(['deploy', 'undo', 'rollback', 'upload', 'delete', 'write', 'rename', 'mkdir'])

const ops = atom({ plugin: 'coolftp-live', key: 'ops' } as const, [])
const now = atom({ plugin: 'coolftp-live', key: 'now' } as const, 0)

const GLYPH: Record<OpStatus, string> = { running: '◐', ok: '✓', warn: '!', error: '✗' }
const COLOR: Record<OpStatus, string> = { running: BLUE, ok: 'success', warn: 'warning', error: 'error' }

let ticker: Timer | undefined
let isOpened = false

async function openPane($: EngineInterface) {
  isOpened = true
  return $.ui.open({ id: PANE, title: TITLE })
}

async function tick($: EngineInterface) {
  await update($, now, () => Date.now())
  const list = await read($, ops)
  if (!list.some(op => op.status === 'running')) {
    ticker?.cancel()
    ticker = undefined
  }
}

async function begin($: EngineInterface, op: Op) {
  await update($, ops, list => [op, ...list].slice(0, KEEP))
  await update($, now, () => op.startedAt)
  if (!isOpened) openPane($).catch(() => undefined)
  $.ui.status(`coolFTP: ${doing(op.action)}${op.site ? ` ${op.site}` : ''}…`)
  ticker ??= $.clock.every(1000, () => void tick($))
}

async function finish($: EngineInterface, id: string, patch: Partial<Op>) {
  const endedAt = Date.now()
  const list = await update($, ops, all => all.map(op => (op.id === id ? { ...op, ...patch, endedAt } : op)))
  const op = list.find(one => one.id === id)
  const stillRunning = list.find(one => one.status === 'running')
  $.ui.status(stillRunning ? `coolFTP: ${doing(stillRunning.action)}…` : undefined)
  if (op && LOUD.has(op.action)) {
    const mark = op.status === 'ok' ? '✓' : op.status === 'warn' ? '!' : '✗'
    $.ui.toast(`coolFTP ${mark} ${op.action}${op.summary ? `: ${op.summary}` : ''}`)
  }
  const kept = list.filter(one => one.status !== 'running').slice(0, 20).map(one => ({ ...one, isEarlier: true }))
  await $.store.set(STORE_KEY, kept).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'coolftp-panel',
      description: 'Show the coolFTP panel: deploys, uploads, live checks and undos as Claude runs them',
    })
    const current = await read($, ops)
    if (current.length === 0) {
      const saved = await $.store.get(STORE_KEY).catch(() => undefined)
      if (Array.isArray(saved) && saved.length) await update($, ops, () => saved as Op[])
    }
    openPane($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'coolftp-panel' }, async $ => {
    await openPane($)

    return { text: 'coolFTP panel opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const fromMcp = mcpAction(tool)
    const fromCli = e.tool === 'Bash' ? cliAction(e.command) : undefined
    const action = fromMcp ?? fromCli
    if (!action) return next(e)

    const args = e as unknown as Record<string, unknown>
    const op: Op = {
      id: e.tool_use_id,
      action,
      via: fromMcp ? 'mcp' : 'cli',
      site: typeof args.site === 'string' ? args.site : undefined,
      target: fromMcp ? targetOf(action, args) : e.tool === 'Bash' ? e.command.slice(0, 120) : undefined,
      status: 'running',
      startedAt: Date.now(),
    }
    await begin($, op)

    let ran
    try {
      ran = await next(e)
    } catch (err) {
      await finish($, op.id, { status: 'error', summary: String((err as Error)?.message ?? err).slice(0, 120) })
      throw err
    }

    if (ran.deny !== undefined) {
      await finish($, op.id, { status: 'error', summary: `blocked: ${ran.deny.slice(0, 100)}` })
    } else {
      const got = outcome(action, ran.text ?? '', ran.isError === true)
      await finish($, op.id, {
        status: got.status,
        summary: got.summary,
        url: got.url,
        site: op.site ?? got.site,
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = await read($, ops)
    const at = Math.max(await read($, now), Date.now())

    const current = list.filter(op => !op.isEarlier)
    const earlier = list.filter(op => op.isEarlier)
    const deploys = current.filter(op => op.action === 'deploy' && op.target !== 'dry run')
    const running = current.filter(op => op.status === 'running').length
    const failed = current.filter(op => op.status === 'error').length

    const row = (op: Op) => (
      <Box key={op.id} flexDirection="column" marginBottom={1}>
        <Box justifyContent="space-between">
          <Text wrap="truncate">
            <Text color={COLOR[op.status]} bold>
              {GLYPH[op.status]}{' '}
            </Text>
            <Text bold color={op.isEarlier ? undefined : op.status === 'running' ? BLUE : undefined} dimColor={op.isEarlier}>
              {op.action}
            </Text>
            {op.site ? <Text dimColor> {op.site}</Text> : null}
            {op.via === 'cli' ? <Text dimColor> (cli)</Text> : null}
          </Text>
          <Text dimColor>
            {op.status === 'running'
              ? elapsed(at - op.startedAt)
              : `${op.endedAt ? elapsed(op.endedAt - op.startedAt) + ' · ' : ''}${clock(op.startedAt)}`}
          </Text>
        </Box>
        {op.target ? (
          <Text dimColor wrap="truncate-middle">
            {'  '}
            {op.target}
          </Text>
        ) : null}
        {op.status === 'running' ? (
          <Text color={BLUE}>{'  '}{doing(op.action)}…</Text>
        ) : op.summary ? (
          <Text color={op.status === 'ok' ? undefined : COLOR[op.status]} dimColor={op.isEarlier} wrap="wrap">
            {'  '}
            {op.summary}
          </Text>
        ) : null}
        {op.url && !op.isEarlier ? (
          <Text>
            {'  '}
            <Link href={op.url}>{op.url}</Link>
          </Text>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between" marginBottom={1}>
          <Text>
            <Text bold color={BLUE}>
              cool
            </Text>
            <Text bold color={DEEP}>
              FTP
            </Text>
            <Text dimColor> live</Text>
          </Text>
          <Text dimColor>
            {running ? `${running} running · ` : ''}
            {deploys.length} deploy{deploys.length === 1 ? '' : 's'}
            {failed ? ` · ${failed} failed` : ''}
          </Text>
        </Box>
        {current.length === 0 && (
          <Text dimColor>
            Nothing yet. When Claude deploys, uploads, checks or undoes with coolFTP, each step shows up here as it runs.
          </Text>
        )}
        {current.map(row)}
        {earlier.length > 0 && (
          <Box flexDirection="column" marginTop={current.length ? 0 : 1}>
            <Text dimColor bold>
              Earlier sessions
            </Text>
            {earlier.slice(0, 8).map(row)}
          </Box>
        )}
        {list.length > 0 && (
          <Box>
            <Button
              key="clear"
              label="Clear"
              hotkey="c"
              onPress={async () => {
                await update($, ops, all => all.filter(op => op.status === 'running'))
                await $.store.delete(STORE_KEY).catch(() => undefined)
              }}
            />
          </Box>
        )}
      </Box>
    )
  })
}
