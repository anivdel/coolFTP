import { expect, mock, test } from 'claude-code/testing'

import { cliAction, mcpAction, outcome } from '../hooks/parse'
import { heroSvg, words } from '../hooks/scene'

const DEPLOY_TEXT = [
  '↑ /index.html (2.1 KB)',
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
  expect(words({ ...base, action: 'diff', status: 'error', error: 'Error: Unknown site "coolFTP"' }).detail).toContain('Open the coolFTP app')
  expect(heroSvg(undefined)).toContain('Ready when Claude is')
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
    $.ui.mount({ plugin: 'coolftp-live', surface, component: 'Pane', requestId: 'coolftp-live', props: PANE_PROPS })

  const terminal = await mountPane('terminal')
  expect(await terminal.find({ type: 'Text', text: /Your site is live/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /3 files updated · 2.1 KB/ })).toBeDefined()
  await terminal.unmount()

  for (const surface of ['desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'coolftp-live', surface, component: 'Pane', requestId: 'coolftp-live', props: PANE_PROPS })
    const hero = await ui.find({ type: 'Svg' })
    expect(hero?.props.alt).toBe('Your site is live')
    expect(String(hero?.props.source)).toContain('demo.example.com')
    expect(await ui.find({ type: 'Text', text: /3 files updated · 2.1 KB/ })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await mountPane('desktop')
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /Ask Claude to publish your site/ })).toBeDefined()
  await ui.unmount()
})
