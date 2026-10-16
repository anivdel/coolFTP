import { expect, mock, test } from 'claude-code/testing'

import { checkedUrl, cliAction, liveFileName, loadMsOf, mcpAction, outcome, placeOf, progressOf } from '../hooks/parse'
import { heroSvg, moodOf, progressBar, progressWords, tallyAlt, tallyOf, tallySvg, words } from '../hooks/scene'

const DEPLOY_TEXT = [
  '↑ /index.html (2.1 KB)',
  '200 https://demo.example.com/ (175ms)',
  '',
  JSON.stringify({
    site: 'demo',
    live: 'live: every check passed',
    record: { duration: '2s', bytes: 2150 },
    plan: { counts: { add: 1, change: 2, delete: 0 }, bytes: 2150 },
    urls: ['https://demo.example.com/'],
  }),
].join('\n')

const PANE_PROPS = {
  title: 'coolFTP',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

test('reads tool names and results', async () => {
  expect(mcpAction('mcp__coolftp__coolftp_deploy')).toBe('deploy')
  expect(mcpAction('mcp__plugin_coolftp_coolftp__coolftp_undo')).toBe('undo')
  expect(mcpAction('mcp__other__thing')).toBeUndefined()
  expect(cliAction('cd site && npx coolftp deploy --dry-run')).toBe('deploy')
  expect(cliAction('echo coolftpish')).toBeUndefined()

  const ok = outcome('deploy', DEPLOY_TEXT, false)
  expect(ok.status).toBe('ok')
  expect(ok.summary).toBe('+1 ~2 −0 · 2.1 KB · 2s · live')
  expect(ok.url).toBe('https://demo.example.com/')

  const bad = outcome('deploy', DEPLOY_TEXT.replace('live: every check passed', 'NOT VERIFIED: nope'), false)
  expect(bad.status).toBe('error')
  expect(outcome('upload', 'Error: no route to host', true).summary).toBe('no route to host')
})

test('plain words for each step', async () => {
  const base = { id: 'x', via: 'mcp' as const, startedAt: 0, site: 'coolftp.com' }
  expect(words({ ...base, action: 'deploy', status: 'running' }).title).toBe('Publishing your site to coolftp.com')
  expect(words({ ...base, action: 'deploy', status: 'ok', live: 'live', files: 2 }).title).toBe('Your site is live')
  expect(words({ ...base, action: 'deploy', status: 'ok', isPreview: true, files: 0 }).title).toBe('Everything is already up to date')
  expect(words({ ...base, action: 'upload', status: 'ok', target: 'C:/site/index.html', files: 1 }).title).toBe('index.html is on coolftp.com')
  expect(words({ ...base, action: 'diff', status: 'error', error: 'Error: Unknown site "coolFTP"' }).detail).toContain("doesn't have this site saved")
  expect(heroSvg(undefined)).toContain('Ready when Claude is')
  expect(loadMsOf(['Checking https://x.com', '200 https://x.com/ (252ms)', ''].join('\n'))).toBe(252)
  const tally = tallyOf([{ ...base, action: 'upload', status: 'ok', files: 5, endedAt: 0 }, { ...base, action: 'verify', status: 'ok', live: 'live', loadMs: 1400, isEarlier: true }], 180_000)
  expect(tallyAlt(tally)).toBe('Last change 3 min ago, 5 files sent, site up, loads in 1.4s')
  expect(tallySvg(tally)).toContain('3 min')
})

test('a deploy shows in the panel on every surface', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const toasts: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('tool.call', { tool: 'mcp__coolftp__coolftp_deploy' }, () => ({ result: {}, text: DEPLOY_TEXT }))
  await $.tool.call({ tool: 'mcp__coolftp__coolftp_deploy', site: 'demo' })

  expect(toasts[0]).toBe('coolFTP ✓ Your site is live')

  const mountPane = (surface: 'terminal' | 'desktop' | 'vscode') =>
    $.ui.mount({ plugin: 'coolftp', surface, component: 'Pane', requestId: 'coolftp', props: PANE_PROPS })

  const terminal = await mountPane('terminal')
  expect(await terminal.find({ type: 'Text', text: /Your site is live/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /3 files updated · 2.1 KB/ })).toBeDefined()
  await terminal.unmount()

  for (const surface of ['desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'coolftp', surface, component: 'Pane', requestId: 'coolftp', props: PANE_PROPS })
    const hero = await ui.find({ type: 'Svg' })
    expect(hero?.props.alt).toBe('Your site is live')
    expect(String(hero?.props.source)).toContain('demo.example.com')
    expect(await ui.find({ type: 'Text', text: /3 files updated · 2.1 KB/ })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    const tiles = (await ui.findAll({ type: 'Svg' }))[1]
    expect(tiles?.props.alt).toBe('Changed just now, 3 files sent, site up, loads in 0.2s')
    await ui.unmount()
  }

  const ui = await mountPane('desktop')
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /Ask Claude to publish your site/ })).toBeDefined()
  await ui.unmount()
})

test('reads the site a folder deploys to', async () => {
  expect(placeOf({ config: { site: 'coolFTP' }, site: { name: 'coolFTP', host: 'coolftp.com' } })).toEqual({ site: 'coolFTP', host: 'coolftp.com' })
  expect(placeOf({ config: { site: 'jledvina' } })).toEqual({ site: 'jledvina', host: undefined })
  expect(placeOf({ config: { site: 'jledvina', url: 'https://jledvina.com' } })).toEqual({ site: 'jledvina', host: 'jledvina.com' })
  expect(placeOf({ config: null })).toBeUndefined()
  expect(checkedUrl('Checking https://coolftp.com and 1 file\n200 https://coolftp.com/ (897ms)')).toBe('https://coolftp.com')
})

test('each step names the site it went to, across projects', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const statuses: Record<string, object> = {
    'C:/work/coolftp': { config: { site: 'coolFTP' }, site: { name: 'coolFTP', url: 'https://coolftp.com', host: 'coolftp.com' } },
    'C:/work/jledvina': { config: { site: 'jledvina' } },
  }
  const sites = [{ name: 'jledvina', url: 'https://jledvina.com' }]
  const statusLines: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', (_$, e) => {
    if (e.text) statusLines.push(String(e.text))
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('mcp.connect', () => ({ value: { isConnected: true as const, server: 'plugin:coolftp:coolftp' } }))
  on('mcp.call', (_$, e) => {
    const body = e.tool === 'coolftp_status' ? statuses[String((e.args as { cwd?: string } | undefined)?.cwd)] : sites
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }] } }
  })
  const UPLOAD = JSON.stringify({ files: 1, bytes: 900, verified: 1 })
  on('tool.call', { tool: 'mcp__coolftp__coolftp_upload' }, () => ({ result: {}, text: UPLOAD }))

  await $.tool.call({ tool: 'mcp__coolftp__coolftp_upload', cwd: 'C:/work/coolftp', local: 'index.html' })
  await $.tool.call({ tool: 'mcp__coolftp__coolftp_upload', cwd: 'C:/work/jledvina', local: 'about.html' })
  /* Once learned, the domain is there from the first moment of the next step. */
  await $.tool.call({ tool: 'mcp__coolftp__coolftp_upload', cwd: 'C:/work/coolftp', local: 'logo.png' })
  expect(statusLines.at(-1)).toBe('coolFTP: uploading coolftp.com…')

  const ui = await $.ui.mount({ plugin: 'coolftp', surface: 'terminal', component: 'Pane', requestId: 'coolftp', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /logo\.png is on coolftp\.com/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /about\.html is on jledvina\.com/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /index\.html is on coolftp\.com/ })).toBeDefined()
  await ui.unmount()
})

const LIVE = {
  v: 1,
  method: 'deploy',
  startedAt: Number.MAX_SAFE_INTEGER,
  finished: false,
  files: [
    { remote: '/public_html/media/intro-video.mp4', size: 48 * 1024 * 1024, transferred: 12 * 1024 * 1024 },
    { remote: '/public_html/index.html', size: 4000, transferred: 1000 },
  ],
  done: 3,
  totalFiles: 12,
  bytes: 20 * 1024 * 1024,
  totalBytes: 80 * 1024 * 1024,
  rate: 2 * 1024 * 1024,
  etaMs: 30_000,
}

test('reads the live progress file', async () => {
  expect(liveFileName(String.raw`C:\Users\justi\Desktop\Woodpecker`)).toBe('c-users-justi-desktop-woodpecker.json')
  const p = progressOf(JSON.stringify(LIVE), 0)!
  expect(p.file).toBe('/public_html/media/intro-video.mp4')
  expect(p.fraction).toBe(0.25)
  expect(p.alsoMoving).toBe(1)
  const w = progressWords(p)
  expect(w.file).toBe('…/media/intro-video.mp4 · 12.0 MB of 48.0 MB · +1 more at once')
  expect(w.job).toBe('3 of 12 files · 20.0 MB of 80.0 MB · 2.0 MB/s · about 30s left')
  expect(progressBar(0.25, 8)).toBe('██░░░░░░ 25%')
  expect(progressOf(JSON.stringify({ ...LIVE, finished: true }), 0)).toBeUndefined()
  expect(progressOf(JSON.stringify({ ...LIVE, startedAt: 1000 }), 60_000)).toBeUndefined()
  expect(progressOf('not json', 0)).toBeUndefined()
})

test('a running deploy shows the file moving and a progress bar', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('mcp.connect', () => ({ value: { isConnected: false as const, reason: 'missing' as never, message: '' } }))
  const reads: string[] = []
  on('fs.read', (_$, e) => {
    reads.push(String((e as { path?: string }).path))
    return { value: JSON.stringify(LIVE) }
  })
  let release: () => void = () => undefined
  on('tool.call', { tool: 'mcp__coolftp__coolftp_deploy' }, () => new Promise(r => (release = () => r({ result: {}, text: DEPLOY_TEXT }))))

  const running = $.tool.call({ tool: 'mcp__coolftp__coolftp_deploy', cwd: 'C:/work/woodpecker' })
  await clock.advance(1100)
  expect(reads.some(p => /[\\/]\.live[\\/]c-work-woodpecker\.json$/.test(p))).toBe(true)

  const terminal = await $.ui.mount({ plugin: 'coolftp', surface: 'terminal', component: 'Pane', requestId: 'coolftp', props: PANE_PROPS })
  expect(await terminal.find({ type: 'Text', text: /intro-video\.mp4 · 12\.0 MB of 48\.0 MB/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /█+░+ 25%/ })).toBeDefined()
  await terminal.unmount()

  const ui = await $.ui.mount({ plugin: 'coolftp', surface: 'desktop', component: 'Pane', requestId: 'coolftp', props: PANE_PROPS })
  const bar = (await ui.findAll({ type: 'Svg' }))[1]
  expect(String(bar?.props.alt)).toContain('25% done')
  expect(await ui.find({ type: 'Text', text: /3 of 12 files · 20\.0 MB of 80\.0 MB/ })).toBeDefined()
  await ui.unmount()

  release()
  await running
  const after = await $.ui.mount({ plugin: 'coolftp', surface: 'terminal', component: 'Pane', requestId: 'coolftp', props: PANE_PROPS })
  expect(await after.find({ type: 'Text', text: /Your site is live/ })).toBeDefined()
  await after.unmount()
})

test('each step lists the files it touched', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const deployText = JSON.stringify({
    site: 'Woodpecker',
    remoteRoot: '/',
    live: 'live: every check passed',
    plan: { counts: { add: 3, change: 3, delete: 1 }, add: ['media/a.mp4', 'media/b.mp4', 'media/c.mp4'], change: ['index.html', 'styles.css', 'app.js'], delete: ['old.html'] },
    urls: ['https://woodpeckerdig.com/'],
  })
  const uploadText = ['↑ /public_html/download/setup.exe (75.2 MB)', '', JSON.stringify({ files: 1, bytes: 78871265 })].join('\n')
  on('tool.call', { tool: 'mcp__coolftp__coolftp_deploy' }, () => ({ result: {}, text: deployText }))
  on('tool.call', { tool: 'mcp__coolftp__coolftp_upload' }, () => ({ result: {}, text: uploadText }))
  await $.tool.call({ tool: 'mcp__coolftp__coolftp_deploy', cwd: 'C:/w' })
  expect(outcome('upload', uploadText, false).touched).toEqual([{ path: 'download/setup.exe', kind: 'sent', size: '75.2 MB' }])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'coolftp', surface, component: 'Pane', requestId: 'coolftp', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /\+ media\/a\.mp4/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~ index\.html/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /old\.html/ })).toBeUndefined()
    await ui.press({ key: 'more-' + (await ui.find({ type: 'Button', props: { label: 'All 7 files' } }))!.key!.slice(5) })
    expect(await ui.find({ type: 'Text', text: /− old\.html/ })).toBeDefined()
    await ui.press({ key: 'more-' + (await ui.find({ type: 'Button', props: { label: 'Fewer files' } }))!.key!.slice(5) })
    await ui.unmount()
  }
})

test('the yeti works in the hero, in every mood, within the drawing budget', async () => {
  const base = { id: 'x', via: 'mcp' as const, startedAt: 0, site: 'woodpeckerdig.com' }
  const steps = [
    undefined,
    { ...base, action: 'deploy', status: 'running' as const },
    { ...base, action: 'download', status: 'running' as const },
    { ...base, action: 'verify', status: 'running' as const },
    { ...base, action: 'deploy', status: 'ok' as const, live: 'live' as const },
    { ...base, action: 'deploy', status: 'warn' as const },
    { ...base, action: 'deploy', status: 'error' as const, error: 'ECONNREFUSED' },
  ]
  expect(steps.map(moodOf)).toEqual(['idle', 'send', 'fetch', 'scan', 'happy', 'worry', 'cross'])
  for (const op of steps) {
    const svg = heroSvg(op, 'woodpeckerdig.com')
    expect(svg).toContain('<image href="data:image/png;base64,')
    expect(svg.length).toBeLessThan(131072)
  }
})
