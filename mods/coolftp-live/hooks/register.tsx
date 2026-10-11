import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Op, OpStatus } from '../types'
import { clock, cliAction, doing, elapsed, mcpAction, outcome, targetOf } from './parse'
import { QUIET, ago, heroSvg, iconSvg, tallyOf, tallySvg, took, words } from './scene'

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

/** Every second while a step runs (its timer), every 30 s otherwise ("2 min ago"). */
async function tick($: EngineInterface) {
  const list = await read($, ops)
  const last = await read($, now)
  const t = Date.now()
  if (list.some(op => op.status === 'running') || t - last >= 30_000) await update($, now, () => t)
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
  if (op && LOUD.has(op.action) && !op.isPreview) {
    const mark = op.status === 'ok' ? '✓' : op.status === 'warn' ? '!' : '✗'
    $.ui.toast(`coolFTP ${mark} ${words(op).title}`)
  }
  const kept = list.filter(one => one.status !== 'running').slice(0, 20).map(one => ({ ...one, isEarlier: true }))
  await $.store.set(STORE_KEY, kept).catch(() => undefined)
}

const hostOf = (url?: string) => {
  const m = url ? /^https?:\/\/([^/:]+)/.exec(url) : null
  return m ? m[1] : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'coolftp-panel',
      description: 'Show the coolFTP panel: watch Claude publish your site, step by step',
    })
    const current = await read($, ops)
    if (current.length === 0) {
      const saved = await $.store.get(STORE_KEY).catch(() => undefined)
      if (Array.isArray(saved) && saved.length) await update($, ops, () => saved as Op[])
    }
    ticker ??= $.clock.every(1000, () => void tick($))
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
    if (!action || QUIET.has(action)) return next(e)

    const args = e as unknown as Record<string, unknown>
    const op: Op = {
      id: e.tool_use_id,
      action,
      via: fromMcp ? 'mcp' : 'cli',
      site: typeof args.site === 'string' ? args.site : undefined,
      target: fromMcp ? targetOf(action, args) : e.tool === 'Bash' ? e.command.slice(0, 120) : undefined,
      status: 'running',
      startedAt: Date.now(),
      isPreview: args.dryRun === true || action === 'diff' || (fromCli !== undefined && /--dry-run/.test(String(args.command))),
    }
    await begin($, op)

    let ran
    try {
      ran = await next(e)
    } catch (err) {
      const message = String((err as Error)?.message ?? err)
      await finish($, op.id, { status: 'error', summary: message.slice(0, 120), error: message })
      throw err
    }

    if (ran.deny !== undefined) {
      await finish($, op.id, { status: 'error', summary: `blocked: ${ran.deny.slice(0, 100)}`, error: `blocked: ${ran.deny}` })
    } else {
      const text = ran.text ?? ''
      const got = outcome(action, text, ran.isError === true)
      await finish($, op.id, {
        status: got.status,
        summary: got.summary,
        url: got.url,
        site: op.site ?? got.site,
        files: got.files,
        bytes: got.bytes,
        live: got.live,
        checks: got.checks,
        isPreview: op.isPreview || got.isPreview,
        error: ran.isError === true ? text.slice(0, 400) : undefined,
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, ops)
    const at = Math.max(await read($, now), Date.now())
    const current = list.filter(op => !op.isEarlier)
    const earlier = list.filter(op => op.isEarlier)

    /* The terminal draws no pictures: the same story in lines of text. */
    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      const row = (op: Op) => {
        const w = words(op)
        return (
          <Box key={op.id} flexDirection="column" marginBottom={1}>
            <Box justifyContent="space-between">
              <Text wrap="truncate">
                <Text color={COLOR[op.status]} bold>
                  {GLYPH[op.status]}{' '}
                </Text>
                <Text bold dimColor={op.isEarlier}>{w.title}</Text>
              </Text>
              <Text dimColor>{op.status === 'running' ? elapsed(at - op.startedAt) : clock(op.startedAt)}</Text>
            </Box>
            <Text dimColor wrap="wrap">
              {'  '}
              {w.detail}
            </Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color={BLUE}>cool</Text>
            <Text bold color={DEEP}>FTP</Text>
          </Box>
          {current.length === 0 && <Text dimColor>Ready when Claude is. Ask it to publish your site and each step shows up here.</Text>}
          {current.map(row)}
          {earlier.length > 0 && <Text dimColor bold>Earlier</Text>}
          {earlier.slice(0, 6).map(row)}
          {list.length > 0 && (
            <Button key="clear" label="Clear" hotkey="c" onPress={() => update($, ops, all => all.filter(op => op.status === 'running'))} />
          )}
        </Box>
      )
    }

    const { Box, Text, Button, Link, Svg } = $.ui.resolve(e)
    const width = Math.max(280, Math.min(560, Math.round((e.props.bodyColumns || 56) * 8)))

    /** The domain people know the site by, when a step told us; else the coolFTP site name. */
    const knownHost = list.map(op => hostOf(op.url)).find(Boolean)
    const named = (op: Op): Op => ({ ...op, site: hostOf(op.url) ?? knownHost ?? op.site })

    const focus = current.find(op => op.status === 'running') ?? current[0]
    const shown = focus ? named(focus) : undefined
    const story = shown ? words(shown) : undefined
    const tally = tallyOf(list)
    const liveUrl = current.find(op => op.url && op.status !== 'error')?.url

    const item = (raw: Op) => {
      const op = named(raw)
      const w = words(op)
      const when =
        op.status === 'running'
          ? `${took(at - op.startedAt)} so far`
          : [ago(at - (op.endedAt ?? op.startedAt)), op.endedAt ? `took ${took(op.endedAt - op.startedAt)}` : undefined].filter(Boolean).join(' · ')
      return (
        <Box key={op.id} flexDirection="row" gap={1} marginBottom={1} alignItems="flex-start">
          <Svg source={iconSvg(op)} alt={w.title} width={32} height={32} isInteractive={op.status === 'running'} />
          <Box flexDirection="column" flexGrow={1}>
            <Text bold dimColor={op.isEarlier} wrap="truncate">
              {w.title}
            </Text>
            <Text dimColor wrap="wrap">
              {w.detail}
            </Text>
            <Text dimColor>{when}</Text>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Svg source={heroSvg(shown, knownHost)} alt={story?.title ?? 'Ready when Claude is'} width={width} height={Math.round((width * 200) / 440)} isInteractive />
        <Box flexDirection="column">
          <Text color={shown?.status === 'error' ? 'error' : undefined} wrap="wrap">
            {story ? story.detail : 'Ask Claude to publish your site. You will see your files travel to it, then a check that it is live.'}
            {shown?.status === 'running' ? ` · ${took(at - shown.startedAt)}` : ''}
          </Text>
          {liveUrl && shown?.status !== 'running' && (
            <Link href={liveUrl}>Open {hostOf(liveUrl) ?? 'your site'} ↗</Link>
          )}
        </Box>
        {current.length > 0 && <Svg source={tallySvg(tally)} alt={`${tally.published} published, ${tally.files} files sent`} width={width} height={Math.round((width * 64) / 440)} />}
        {current.length > 1 && <Text bold>What Claude did</Text>}
        {current.length > 1 && <Box flexDirection="column">{current.slice(1).map(item)}</Box>}
        {earlier.length > 0 && <Text bold dimColor>Earlier sessions</Text>}
        {earlier.length > 0 && <Box flexDirection="column">{earlier.slice(0, 6).map(item)}</Box>}
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
