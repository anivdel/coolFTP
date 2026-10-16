import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Op, OpStatus, Place, Touched } from '../types'
import { clock, cliAction, doing, elapsed, liveFileName, mcpAction, outcome, placeOf, progressOf, resultJson, targetOf } from './parse'
import { QUIET, ago, heroSvg, iconSvg, progressBar, progressSvg, progressWords, tallyAlt, tallyOf, tallySvg, took, words } from './scene'

const PANE = 'coolftp'
const TITLE = 'coolFTP'
const KEEP = 40
const STORE_KEY = 'recent'

/** coolFTP blues; status colors come from the person's theme. */
const BLUE = '#4FA3FF'
const DEEP = '#2B6CB0'

/** Calls that change the server: these toast when they finish. */
const LOUD = new Set(['deploy', 'undo', 'rollback', 'upload', 'delete', 'write', 'rename', 'mkdir'])

const ops = atom({ plugin: 'coolftp', key: 'ops' } as const, [])
const now = atom({ plugin: 'coolftp', key: 'now' } as const, 0)
/** Which site each project folder deploys to, as coolFTP answered: the panel names it on every step. */
const where = atom({ plugin: 'coolftp', key: 'where' } as const, {})

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
  const running = list.filter(op => op.status === 'running')
  if (running.length || t - last >= 30_000) await update($, now, () => t)
  for (const op of running) if (MOVES.has(op.action) && op.cwd) await follow($, op)
}

/** Calls that move file bytes: the MCP server reports their progress in a live file. */
const MOVES = new Set(['deploy', 'upload', 'download', 'undo', 'rollback'])

/** Steps whose whole file list is open in the panel, by op id. */
const opened = atom({ plugin: 'coolftp', key: 'opened' } as const, {})

const MARK: Record<Touched['kind'], string> = { new: '+', changed: '~', removed: '−', sent: '↑', fetched: '↓' }
const TONE: Record<Touched['kind'], string | undefined> = { new: 'success', changed: BLUE, removed: 'error', sent: BLUE, fetched: undefined }
const SHOWN = 5

/** The files a step touched: the first few, and the rest behind a button. */
function fileList($: EngineInterface, e: { surface: string }, op: Op, isOpen: boolean, indent = '') {
  const { Box, Text, Button } = $.ui.resolve(e as never)
  const files = op.touched ?? []
  if (!files.length) return null
  const total = files.length + (op.moreTouched ?? 0)
  const shown = isOpen ? files : files.slice(0, SHOWN)
  const hidden = total - shown.length
  return (
    <Box key={`files-${op.id}`} flexDirection="column">
      {shown.map((f, i) => (
        <Text key={`${op.id}-${i}`} wrap="truncate" dimColor={op.isEarlier}>
          {indent}
          <Text color={TONE[f.kind]}>{MARK[f.kind]}</Text> {f.path}
          {f.size ? <Text dimColor> {f.size}</Text> : null}
        </Text>
      ))}
      {isOpen && op.moreTouched ? (
        <Text dimColor>
          {indent}…and {op.moreTouched} more coolFTP did not list
        </Text>
      ) : null}
      {(hidden > 0 || isOpen) && files.length > SHOWN ? (
        <Button
          key={`more-${op.id}`}
          label={isOpen ? 'Fewer files' : `All ${total} files`}
          onPress={() => update($, opened, all => ({ ...all, [op.id]: !all[op.id] }))}
        />
      ) : hidden > 0 ? (
        <Text dimColor>
          {indent}…and {hidden} more
        </Text>
      ) : null}
    </Box>
  )
}

/** Where the MCP server writes live files: COOLFTP_LIVE_DIR in .mcp.json, under the plugin's folder. */
const liveDir = ($: EngineInterface) => `${$.plugin.root.replace(/[\\/]\.claude-plugin[\\/]?$/, '')}/.live`

/** Reads how far a running step is. A missing or stale file leaves the step as it was. */
async function follow($: EngineInterface, op: Op) {
  const text = await $.fs.read(`${liveDir($)}/${liveFileName(op.cwd!)}`).catch(() => undefined)
  const progress = typeof text === 'string' ? progressOf(text, op.startedAt) : undefined
  if (!progress) return
  await update($, ops, all => all.map(one => (one.id === op.id && one.status === 'running' ? { ...one, progress } : one)))
  const pct = progress.fraction !== undefined ? ` ${Math.round(progress.fraction * 100)}%` : ''
  $.ui.status(`coolFTP: ${doing(op.action)}${op.site ? ` ${op.site}` : ''}${pct}…`)
}

/** What the panel says about a step's transfer while it runs. */
function movingOf(op: Op | undefined) {
  if (!op || op.status !== 'running' || !op.progress) return undefined
  const w = progressWords(op.progress)
  const pct = op.progress.fraction !== undefined ? `${Math.round(op.progress.fraction * 100)}% done. ` : ''
  return { ...w, alt: `${pct}${w.file}. ${w.job}` }
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
  const list = await update($, ops, all => all.map(op => (op.id === id ? { ...op, ...patch, progress: undefined, endedAt } : op)))
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

/** The name a step's site goes by: its domain when known, else the coolFTP site name. */
const labelOf = (place: Place | undefined, explicit?: string) =>
  explicit && place?.site && explicit.toLowerCase() !== place.site.toLowerCase() ? explicit : (place?.host ?? place?.site ?? explicit)

let server: string | undefined

/** Asks coolFTP once per folder which site it deploys to. Quiet on failure: the step still shows. */
async function learn($: EngineInterface, cwd: string): Promise<Place | undefined> {
  const known = (await read($, where))[cwd]
  if (known?.host) return known
  try {
    if (!server) {
      const got = await $.mcp.connect('coolftp')
      if (!got.isConnected) return known
      server = got.server
    }
    const textOf = (r: { content?: Array<{ type: string; text?: string }> }) => (r.content ?? []).map(c => c.text ?? '').join('\n')
    const status = resultJson(textOf(await $.mcp.call(server, 'coolftp_status', { cwd })))
    let place = placeOf(status)
    /* Older coolFTP answers the site name only: the saved site's url gives the domain. */
    if (place?.site && !place.host) {
      const sites = JSON.parse(textOf(await $.mcp.call(server, 'coolftp_sites', {}))) as Array<{ name?: string; url?: string }>
      const saved = Array.isArray(sites) ? sites.find(s => s.name === place!.site) : undefined
      place = { ...place, host: hostOf(saved?.url) }
    }
    if (place) await update($, where, all => ({ ...all, [cwd]: { ...all[cwd], ...place } }))
    return place ?? known
  } catch {
    return known
  }
}

/** Puts a learned domain on the steps of that folder that do not name one yet. */
async function relabel($: EngineInterface, cwd: string, explicit: string | undefined, place: Place | undefined) {
  const name = labelOf(place, explicit)
  if (!name) return
  await update($, ops, all => all.map(op => (op.cwd === cwd && !op.isEarlier && (op.site === undefined || op.site === explicit || op.site === place?.site) ? { ...op, site: name } : op)))
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
    const explicit = typeof args.site === 'string' ? args.site : undefined
    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : await $.session.cwd().catch(() => '')
    const place = (await read($, where))[cwd]
    const op: Op = {
      id: e.tool_use_id,
      action,
      via: fromMcp ? 'mcp' : 'cli',
      cwd,
      site: labelOf(place, explicit),
      target: fromMcp ? targetOf(action, args) : e.tool === 'Bash' ? e.command.slice(0, 120) : undefined,
      status: 'running',
      startedAt: Date.now(),
      isPreview: args.dryRun === true || action === 'diff' || (fromCli !== undefined && /--dry-run/.test(String(args.command))),
    }
    await begin($, op)
    if (!place?.host && cwd) void learn($, cwd).then(p => relabel($, cwd, explicit, p))

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
      /* A live check's address names the domain for this folder from now on. */
      const host = hostOf(got.url)
      if (host && cwd && (!explicit || !got.site || explicit === got.site)) {
        await update($, where, all => ({ ...all, [cwd]: { site: got.site ?? all[cwd]?.site, host } }))
      }
      const label = labelOf((await read($, where))[cwd], explicit) ?? got.site
      await finish($, op.id, {
        status: got.status,
        summary: got.summary,
        url: got.url,
        site: label,
        files: got.files,
        bytes: got.bytes,
        live: got.live,
        checks: got.checks,
        loadMs: got.loadMs,
        touched: got.touched?.length ? got.touched : undefined,
        moreTouched: got.moreTouched || undefined,
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
    const open = await read($, opened)

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
            {op.status === 'running' && op.progress ? (
              <Box flexDirection="column">
                <Text wrap="truncate">
                  {'  '}
                  {progressWords(op.progress).file}
                </Text>
                {op.progress.fraction !== undefined && (
                  <Text color={BLUE}>
                    {'  '}
                    {progressBar(op.progress.fraction)}
                  </Text>
                )}
                <Text dimColor wrap="wrap">
                  {'  '}
                  {progressWords(op.progress).job}
                </Text>
              </Box>
            ) : (
              <Text dimColor wrap="wrap">
                {'  '}
                {w.detail}
              </Text>
            )}
            {op.status !== 'running' && fileList($, e, op, open[op.id] === true, '  ')}
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

    /** Each step keeps the site it went to, so two projects in one panel never borrow each other's name. */
    const named = (op: Op): Op => ({ ...op, site: hostOf(op.url) ?? op.site })
    const places = await read($, where)
    const sessionCwd = await $.session.cwd().catch(() => '')
    const idleSite = labelOf(places[sessionCwd]) ?? current.find(op => op.site)?.site

    const focus = current.find(op => op.status === 'running') ?? current[0]
    const shown = focus ? named(focus) : undefined
    const story = shown ? words(shown) : undefined
    const moving = movingOf(shown)
    const tally = tallyOf(list, at)
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
            {op.status !== 'running' && fileList($, e, op, open[op.id] === true)}
            <Text dimColor>{when}</Text>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Svg source={heroSvg(shown, idleSite)} alt={story?.title ?? 'Ready when Claude is'} width={width} height={Math.round((width * 200) / 440)} isInteractive />
        <Box flexDirection="column">
          {moving && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold wrap="truncate">{moving.file}</Text>
              <Svg source={progressSvg(shown!.progress!)} alt={moving.alt} width={width} height={10} isInteractive={shown!.progress!.fraction === undefined} />
              <Text dimColor wrap="wrap">
                {moving.job} · {took(at - shown!.startedAt)}
              </Text>
            </Box>
          )}
          {!moving && (
            <Text color={shown?.status === 'error' ? 'error' : undefined} wrap="wrap">
              {story ? story.detail : 'Ask Claude to publish your site. You will see your files travel to it, then a check that it is live.'}
              {shown?.status === 'running' ? ` · ${took(at - shown.startedAt)}` : ''}
            </Text>
          )}
          {shown && shown.status !== 'running' && fileList($, e, shown, open[shown.id] === true)}
          {liveUrl && shown?.status !== 'running' && (
            <Link href={liveUrl}>Open {hostOf(liveUrl) ?? 'your site'} ↗</Link>
          )}
        </Box>
        {current.length > 0 && <Svg source={tallySvg(tally)} alt={tallyAlt(tally)} width={width} height={Math.round((width * 64) / 440)} />}
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
