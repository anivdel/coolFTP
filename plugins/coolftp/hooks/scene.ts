import type { Op, Progress } from '../types'
import { bytes } from './parse'
import { YETI, type YetiLayer } from './yeti-art'

/** Pictures for the panel: plain words and SVG drawn on surfaces that have it. */

const INK = '#e6edf7'
const SOFT = '#8fb3e0'
const BLUE = '#4fa3ff'
const SKY = '#7dd3fc'
const DEEP = '#2b6cb0'
const NODE = '#13305a'
const GOOD = '#34d399'
const WARN = '#fbbf24'
const BAD = '#fb7185'
const FONT = "'Segoe UI Variable','Segoe UI',system-ui,-apple-system,sans-serif"

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/** Calls that are bookkeeping, not work worth showing. */
export const QUIET = new Set(['status', 'sites', 'history', 'init'])

export type Kind = 'publish' | 'send' | 'fetch' | 'check' | 'look' | 'restore' | 'remove' | 'edit'

export function kindOf(action: string): Kind {
  switch (action) {
    case 'deploy':
      return 'publish'
    case 'upload':
    case 'push':
      return 'send'
    case 'download':
    case 'pull':
      return 'fetch'
    case 'verify':
      return 'check'
    case 'undo':
    case 'rollback':
      return 'restore'
    case 'delete':
    case 'rm':
      return 'remove'
    case 'write':
    case 'mkdir':
    case 'rename':
    case 'mv':
      return 'edit'
    default:
      return 'look'
  }
}

const baseName = (p?: string) => (p ? (p.split(/[\\/]/).filter(Boolean).pop() ?? p) : undefined)

/** What happened, in words someone who has never used FTP reads at a glance. */
export function words(op: Op): { title: string; detail: string } {
  const site = op.site ?? 'your server'
  const name = baseName(op.target)
  const running = op.status === 'running'
  const files = op.files
  const size = op.bytes ? bytes(op.bytes) : undefined
  const fail = op.status === 'error' ? plainError(op.error ?? op.summary ?? '') : undefined

  switch (op.action) {
    case 'deploy':
    case 'diff':
      if (op.isPreview || op.action === 'diff') {
        if (running) return { title: `Seeing what changed on ${site}`, detail: 'Comparing your files with the ones online' }
        if (fail) return { title: `Couldn't compare with ${site}`, detail: fail }
        return {
          title: files ? `${plural(files, 'file')} would change` : 'Everything is already up to date',
          detail: files ? `A preview. Nothing was sent to ${site}.` : `${site} matches your files`,
        }
      }
      if (running) return { title: `Publishing your site to ${site}`, detail: 'Sending only the files that changed' }
      if (fail) return { title: `Couldn't publish to ${site}`, detail: fail }
      if (op.live === 'down') return { title: 'Published, but the site is not answering', detail: `${files ? plural(files, 'file') + ' sent. ' : ''}Visitors may see an error.` }
      if (op.live === 'stale') return { title: 'Published. Some visitors see the old version for a bit', detail: 'A cache in front of your site has not caught up yet' }
      return {
        title: op.live === 'live' ? 'Your site is live' : 'Your site is updated',
        detail: files ? [plural(files, 'file') + ' updated', size].filter(Boolean).join(' · ') : 'Nothing needed changing',
      }
    case 'upload':
      if (running) return { title: `Sending ${name ?? 'files'} to ${site}`, detail: 'Uploading' }
      if (fail) return { title: `Couldn't send ${name ?? 'the files'}`, detail: fail }
      return { title: `${name ?? 'Files'} ${files && files > 1 ? 'are' : 'is'} on ${site}`, detail: [files && files > 1 ? plural(files, 'file') : undefined, size, 'confirmed by the server'].filter(Boolean).join(' · ') }
    case 'download':
      if (running) return { title: `Copying ${name ?? 'files'} from ${site}`, detail: 'Downloading to your computer' }
      if (fail) return { title: `Couldn't copy ${name ?? 'the files'}`, detail: fail }
      return { title: `Copied ${name ?? 'the files'} to your computer`, detail: size ?? 'Done' }
    case 'verify':
      if (running) return { title: `Checking ${site} is up`, detail: 'Opening your pages like a visitor would' }
      if (fail || op.live === 'down') return { title: 'Your site is not answering', detail: fail ?? 'A page did not load. Claude will look into it.' }
      if (op.live === 'stale') return { title: 'Your site is up, with a few old copies', detail: 'A cache has not caught up yet. It usually does within minutes.' }
      return { title: 'Your site is up and answering', detail: op.checks ? `${plural(op.checks, 'page')} checked, all loaded` : 'Every page checked loaded' }
    case 'undo':
    case 'rollback':
      if (running) return { title: 'Putting the previous version back', detail: 'Restoring the files from before the last change' }
      if (fail) return { title: "Couldn't put the previous version back", detail: fail }
      return { title: 'The previous version is back', detail: files ? `${plural(files, 'file')} restored` : 'Restored' }
    case 'delete':
      if (running) return { title: `Removing ${name ?? 'a file'} from ${site}`, detail: 'Taking it off the server' }
      if (fail) return { title: `Didn't remove ${name ?? 'the file'}`, detail: fail }
      return { title: `Removed ${name ?? 'the file'}`, detail: `Gone from ${site}` }
    case 'write':
      if (running) return { title: `Saving ${name ?? 'a file'} on ${site}`, detail: 'Writing' }
      if (fail) return { title: `Couldn't save ${name ?? 'the file'}`, detail: fail }
      return { title: `Saved ${name ?? 'the file'} on ${site}`, detail: size ?? 'Done' }
    case 'mkdir':
      return running ? { title: `Making a folder on ${site}`, detail: name ?? '' } : fail ? { title: "Couldn't make the folder", detail: fail } : { title: `Made the folder ${name ?? ''}`.trim(), detail: `On ${site}` }
    case 'rename':
      return running ? { title: `Renaming on ${site}`, detail: op.target ?? '' } : fail ? { title: "Couldn't rename it", detail: fail } : { title: 'Renamed', detail: op.target ?? '' }
    default:
      if (running) return { title: `Looking at ${site}`, detail: name ? `Reading ${name}` : "Reading the server's files" }
      if (fail) return { title: `Couldn't look at ${site}`, detail: fail }
      return { title: `Looked at ${name ?? 'the files on ' + site}`, detail: 'Nothing was changed' }
  }
}

/** An error, said the way a person would say it. */
export function plainError(raw: string): string {
  const s = raw.replace(/^Error:\s*/, '')
  if (/Unknown site/i.test(s)) return "coolFTP doesn't have this site saved on this computer. Add it in the coolFTP app or with coolftp site add."
  if (/Denied in the coolFTP app/i.test(s)) return 'You said no in the coolFTP app, so nothing changed.'
  if (/blocked:/i.test(s)) return 'This step was blocked before it ran.'
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|timed? ?out|connect/i.test(s)) return "Couldn't reach the server. It may be down or the address changed."
  if (/auth|password|login|530/i.test(s)) return 'The server did not accept the login.'
  if (/No such file|ENOENT|not found|550/i.test(s)) return "That file or folder isn't there."
  return clip(s.split('\n')[0] ?? s, 110)
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

export function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/* ---------- the hero: your computer, the path, your website ---------- */

const W = 440
const H = 200
const L = { x: 84, y: 88 }
const R = { x: 356, y: 88 }
const ARC = `M${L.x + 38},${L.y} Q${W / 2},${L.y - 78} ${R.x - 38},${R.y}`
const ARC_BACK = `M${R.x - 38},${R.y} Q${W / 2},${L.y - 78} ${L.x + 38},${L.y}`

const laptop = (x: number, y: number, stroke: string) =>
  `<rect x="${x - 19}" y="${y - 15}" width="38" height="25" rx="3" fill="#0b1730" stroke="${stroke}" stroke-width="2"/>` +
  `<rect x="${x - 14}" y="${y - 10}" width="28" height="15" rx="1.5" fill="${DEEP}" opacity=".55"/>` +
  `<rect x="${x - 25}" y="${y + 12}" width="50" height="5" rx="2.5" fill="${stroke}"/>`

const globe = (x: number, y: number, stroke: string) =>
  `<g fill="none" stroke="${stroke}" stroke-width="2">` +
  `<circle cx="${x}" cy="${y}" r="19"/>` +
  `<ellipse cx="${x}" cy="${y}" rx="8" ry="19"/>` +
  `<path d="M${x - 19},${y} H${x + 19} M${x - 16},${y - 9} H${x + 16} M${x - 16},${y + 9} H${x + 16}"/>` +
  `</g>`

const paper = (fill: string) =>
  `<g transform="translate(-7,-9)"><path d="M0,0 H10 L14,4 V18 H0 Z" fill="${fill}"/><path d="M10,0 V4 H14" fill="#cfe6ff" opacity=".8"/>` +
  `<path d="M3,8 H11 M3,11 H11 M3,14 H8" stroke="#0b1730" stroke-width="1.2" opacity=".55"/></g>`

const flying = (path: string, count: number, dur: number, fill: string) =>
  Array.from({ length: count }, (_, i) => {
    const begin = ((dur / count) * i).toFixed(2)
    return (
      `<g opacity="0">${paper(fill)}` +
      `<animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${path}"/>` +
      `<animate attributeName="opacity" dur="${dur}s" begin="${begin}s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;.12;.85;1"/></g>`
    )
  }).join('')

const ripple = (x: number, y: number, color: string) =>
  [0, 0.7, 1.4]
    .map(
      b =>
        `<circle cx="${x}" cy="${y}" r="34" fill="none" stroke="${color}" stroke-width="2" opacity="0">` +
        `<animate attributeName="r" values="34;62" dur="2.1s" begin="${b}s" repeatCount="indefinite"/>` +
        `<animate attributeName="opacity" values=".7;0" dur="2.1s" begin="${b}s" repeatCount="indefinite"/></circle>`,
    )
    .join('')

const badge = (x: number, y: number, tone: 'good' | 'warn' | 'bad') => {
  const fill = tone === 'good' ? GOOD : tone === 'warn' ? WARN : BAD
  const mark =
    tone === 'good'
      ? `<path d="M${x - 6},${y} l4,4 l8,-9" fill="none" stroke="#06281c" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`
      : tone === 'warn'
        ? `<path d="M${x},${y - 6} v7" stroke="#2a1d02" stroke-width="2.6" stroke-linecap="round"/><circle cx="${x}" cy="${y + 6}" r="1.6" fill="#2a1d02"/>`
        : `<path d="M${x - 5},${y - 5} l10,10 M${x + 5},${y - 5} l-10,10" stroke="#3a0812" stroke-width="2.6" stroke-linecap="round"/>`
  return (
    `<g><circle cx="${x}" cy="${y}" r="13" fill="${fill}" stroke="#0b1730" stroke-width="3"/>${mark}` +
    `<animate attributeName="opacity" values="0;1" dur=".5s" fill="freeze"/></g>`
  )
}

const spinner = (x: number, y: number, color: string) =>
  `<g><path d="M${x + 12},${y} A12,12 0 1 1 ${x},${y - 12}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/>` +
  `<path d="M${x - 1},${y - 17} l6,5 l-7,4" fill="${color}"/>` +
  `<animateTransform attributeName="transform" type="rotate" from="0 ${x} ${y}" to="-360 ${x} ${y}" dur="1.4s" repeatCount="indefinite"/></g>`

const magnifier = (x: number, y: number) =>
  `<g><circle cx="${x}" cy="${y}" r="9" fill="#0b1730" stroke="${SKY}" stroke-width="3"/><path d="M${x + 7},${y + 7} l8,8" stroke="${SKY}" stroke-width="4" stroke-linecap="round"/>` +
  `<animateTransform attributeName="transform" type="translate" values="-10,0;10,4;-10,0" dur="2.4s" repeatCount="indefinite"/></g>`

const bin = (x: number, y: number) =>
  `<g><path d="M${x - 8},${y - 6} h16 l-2,16 h-12 z" fill="#0b1730" stroke="${SKY}" stroke-width="2.4" stroke-linejoin="round"/><path d="M${x - 11},${y - 7} h22 M${x - 4},${y - 10} h8" stroke="${SKY}" stroke-width="2.4" stroke-linecap="round"/>` +
  `<animateTransform attributeName="transform" type="rotate" values="-8 ${x} ${y};8 ${x} ${y};-8 ${x} ${y}" dur=".9s" repeatCount="indefinite"/></g>`

/* ---------- the yeti, rigged from the logo (hooks/yeti-art.ts) ---------- */

export type Mood = 'idle' | 'send' | 'fetch' | 'scan' | 'look' | 'worry' | 'happy' | 'cross'

/** What the yeti is doing for a step. */
export function moodOf(op: Op | undefined): Mood {
  if (!op) return 'idle'
  const kind = kindOf(op.action)
  if (op.status === 'error') return 'cross'
  if (op.status === 'warn') return 'worry'
  if (op.status === 'ok') return 'happy'
  if (op.isPreview || op.action === 'diff') return 'scan'
  if (kind === 'publish' || kind === 'send' || kind === 'edit') return 'send'
  if (kind === 'fetch') return 'fetch'
  if (kind === 'check') return 'scan'
  if (kind === 'restore' || kind === 'remove') return 'worry'
  return 'look'
}

const img = (l: YetiLayer) => `<g transform="translate(${l.x} ${l.y})">${l.svg}</g>`

/** A looping SMIL transform; `values` in the attribute's own syntax. */
const loop = (type: string, values: string, dur: number, extra = '') =>
  `<animateTransform attributeName="transform" type="${type}" values="${values}" dur="${dur}s" repeatCount="indefinite"${extra}/>`

/**
 * The yeti's head, `h` tall with its top centre at (x, y). Moods: idle breathes and blinks, send
 * nods along with the files and watches them go right, fetch watches them come left, scan reads
 * side to side, happy beams and bounces, worry looks up wide-eyed, cross glares and shakes.
 */
export function yetiSvg(mood: Mood, x: number, y: number, h: number): string {
  const k = h / 594
  const busy = mood === 'send' || mood === 'fetch'
  /* Whole head: a slow breath when idle, a nod per file when working, a hop when happy. */
  const body =
    mood === 'happy'
      ? loop('translate', '0 0;0 -40;0 0;0 -16;0 0;0 0', 1.6, ' keyTimes="0;.18;.36;.5;.62;1" calcMode="spline" keySplines=".3 0 .7 1;.3 0 .7 1;.3 0 .7 1;.3 0 .7 1;0 0 1 1"')
      : mood === 'cross'
        ? loop('translate', '0 0;-14 0;14 0;-10 0;10 0;0 0;0 0', 1.8, ' keyTimes="0;.06;.12;.18;.24;.3;1"')
        : busy
          ? loop('translate', '0 0;0 10;0 0', 0.55)
          : loop('translate', '0 0;0 -6;0 0', 3.2, ' calcMode="spline" keySplines=".4 0 .6 1;.4 0 .6 1" keyTimes="0;.5;1"')
  const tilt =
    mood === 'worry' ? loop('rotate', '-5 269 300;5 269 300;-5 269 300', 2.4) : mood === 'scan' ? loop('rotate', '-2 269 300;2 269 300;-2 269 300', 2) : loop('rotate', '-1.5 269 300;1.5 269 300;-1.5 269 300', 4)
  /* Where the eyes look: right after the files, left as they come back, side to side reading. */
  const gaze =
    mood === 'send'
      ? loop('translate', '4 -2;12 -6;4 -2', 0.55)
      : mood === 'fetch'
        ? loop('translate', '-12 -4;-4 0;-12 -4', 0.55)
        : mood === 'scan'
          ? loop('translate', '-12 2;12 2;-12 2', 1.6)
          : mood === 'look'
            ? loop('translate', '0 0;8 0;8 0;-8 0;-8 0;0 0', 4)
            : ''
  const eye = (l: YetiLayer) => {
    const cx = l.x + l.w / 2
    const cy = l.y + l.h / 2
    /* Blink about each eye's own centre: move it to the origin, squash, move it back. */
    return `<g transform="translate(${cx} ${cy})"><g>${loop('scale', '1 1;1 1;1 .1;1 1', 4.2, ' keyTimes="0;.9;.95;1"')}<g transform="translate(${-cx} ${-cy})">${img(l)}</g></g></g>`
  }
  const brow =
    mood === 'cross'
      ? `<g transform="translate(0 10)">${img(YETI.brow)}</g>`
      : mood === 'worry' || mood === 'happy'
        ? `<g transform="translate(0 -14)">${img(YETI.brow)}</g>`
        : busy
          ? `<g>${loop('translate', '0 0;0 -5;0 0', 0.55)}${img(YETI.brow)}</g>`
          : img(YETI.brow)
  const eyes =
    mood === 'happy'
      ? `<g fill="none" stroke="#000" stroke-width="12" stroke-linecap="round"><path d="M182 236 Q205 204 228 236"/><path d="M313 236 Q336 204 359 236"/></g>`
      : mood === 'worry'
        ? `<g><ellipse cx="205" cy="227" rx="25" ry="26" fill="#fff" stroke="#000" stroke-width="5"/><circle cx="206" cy="221" r="12"/><ellipse cx="336" cy="227" rx="25" ry="26" fill="#fff" stroke="#000" stroke-width="5"/><circle cx="335" cy="221" r="12"/></g>`
        : `<g>${gaze}${eye(YETI.eyeL)}${eye(YETI.eyeR)}</g>`
  /* Happy: the jaw drops a little into a grin. */
  const teeth = mood === 'happy' ? `<g transform="translate(0 6)">${img(YETI.teeth)}</g>` : img(YETI.teeth)
  const shadow = `<ellipse cx="269" cy="600" rx="190" ry="22" fill="#000" opacity=".28"/>`
  return (
    `<g transform="translate(${x - 269 * k} ${y}) scale(${k})">${shadow}` +
    `<g>${body}<g>${tilt}${img(YETI.base)}${teeth}${brow}${eyes}</g></g></g>`
  )
}

/**
 * The whole story in one picture. `op` is the step to show (the running one,
 * else the newest); undefined draws the idle scene.
 */
export function heroSvg(op: Op | undefined, siteFallback?: string): string {
  const site = clip(op?.site ?? siteFallback ?? 'your website', 22)
  const running = op?.status === 'running'
  const kind = op ? kindOf(op.action) : undefined
  const tone = op?.status === 'ok' ? 'good' : op?.status === 'warn' ? 'warn' : op?.status === 'error' ? 'bad' : undefined
  const preview = op?.isPreview || op?.action === 'diff'
  const headline = op ? words(op).title : 'Ready when Claude is'

  const arcColor = tone === 'bad' ? BAD : running ? BLUE : op ? DEEP : '#244a7a'
  const arcDash = tone === 'bad' ? '3 9' : running ? '5 7' : op ? '0' : '4 8'
  const arcAnim = running ? `<animate attributeName="stroke-dashoffset" from="0" to="-24" dur=".7s" repeatCount="indefinite"/>` : ''

  let action = ''
  if (running && (kind === 'publish' || kind === 'send' || kind === 'edit') && !preview) action = flying(ARC, 4, 2.2, BLUE)
  else if (running && kind === 'fetch') action = flying(ARC_BACK, 4, 2.2, SKY)
  else if (running && kind === 'check')
    action =
      ripple(R.x, R.y, SKY) +
      `<circle r="5" fill="${SKY}"><animateMotion dur="1.6s" repeatCount="indefinite" keyPoints="0;1;0" keyTimes="0;.5;1" calcMode="linear" path="${ARC}"/></circle>`
  else if (running && kind === 'restore') action = spinner(R.x, R.y - 54, SKY)
  else if (running && kind === 'remove') action = bin(R.x, R.y - 54)
  else if (running) action = magnifier(R.x, R.y - 52)

  const glow = tone === 'good' && (kind === 'publish' || kind === 'check') && !preview ? ripple(R.x, R.y, GOOD).replace(/repeatCount="indefinite"/g, 'repeatCount="2"') : ''
  const rightRing = tone === 'good' ? GOOD : tone === 'warn' ? WARN : tone === 'bad' ? BAD : running ? BLUE : DEEP

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0c1a33"/><stop offset="1" stop-color="#112b52"/></linearGradient>` +
    `<radialGradient id="halo" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${BLUE}" stop-opacity=".28"/><stop offset="1" stop-color="${BLUE}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${W}" height="${H}" rx="16" fill="url(#bg)"/>` +
    [[40, 26], [130, 40], [205, 18], [300, 30], [402, 22], [250, 52], [60, 150], [395, 150]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.2" fill="#cfe6ff" opacity=".35"/>`).join('') +
    `<path d="${ARC}" fill="none" stroke="${arcColor}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${arcDash}">${arcAnim}</path>` +
    `<circle cx="${L.x}" cy="${L.y}" r="52" fill="url(#halo)"/>` +
    `<circle cx="${L.x}" cy="${L.y}" r="36" fill="${NODE}" stroke="${DEEP}" stroke-width="2"/>` +
    laptop(L.x, L.y, '#93c5fd') +
    `<circle cx="${R.x}" cy="${R.y}" r="52" fill="url(#halo)"/>` +
    glow +
    `<circle cx="${R.x}" cy="${R.y}" r="36" fill="${NODE}" stroke="${rightRing}" stroke-width="2.5"/>` +
    globe(R.x, R.y, SKY) +
    /* The yeti does the work, under the path the files fly along. */
    yetiSvg(moodOf(op), W / 2, 66, 88) +
    action +
    (tone ? badge(R.x + 27, R.y - 27, tone) : '') +
    `<text x="${L.x}" y="${L.y + 56}" text-anchor="middle" font-size="12" fill="${SOFT}">Your computer</text>` +
    `<text x="${R.x}" y="${R.y + 56}" text-anchor="middle" font-size="12" fill="${SOFT}">${esc(site)}</text>` +
    `<text x="${W / 2}" y="${H - 18}" text-anchor="middle" font-size="18" font-weight="700" fill="${INK}">${esc(clip(headline, 44))}</text>` +
    `</svg>`
  )
}

/* ---------- a transfer in flight ---------- */

const eta = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 5 ? 'almost done' : s < 60 ? `about ${s}s left` : `about ${Math.round(s / 60)} min left`
}

/** The file moving now and how far the whole job is, in two short lines. */
export function progressWords(p: Progress): { file: string; job: string } {
  const name = p.file ? clip(p.file.replace(/^.*[\\/](?=[^\\/]+[\\/][^\\/]+$)/, '…/'), 48) : 'Starting'
  const of = p.fileSize ? ` · ${bytes(p.fileBytes ?? 0)} of ${bytes(p.fileSize)}` : ''
  const file = `${name}${of}${p.alsoMoving ? ` · +${p.alsoMoving} more at once` : ''}`
  const parts = [
    p.totalFiles ? `${p.done} of ${plural(p.totalFiles, 'file')}` : p.done ? `${plural(p.done, 'file')} done` : undefined,
    p.totalBytes ? `${bytes(p.bytes ?? 0)} of ${bytes(p.totalBytes)}` : undefined,
    p.rate ? `${bytes(p.rate)}/s` : undefined,
    p.etaMs && p.fraction !== undefined && p.fraction < 1 ? eta(p.etaMs) : undefined,
  ].filter(Boolean)
  return { file, job: parts.join(' · ') || 'Connecting' }
}

/** A text bar for the terminal: `██████░░░░ 60%`. */
export function progressBar(fraction: number, width = 20): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled) + ` ${Math.round(fraction * 100)}%`
}

export function progressSvg(p: Progress): string {
  const f = p.fraction
  const fill = f === undefined ? '' : `<rect x="0" y="0" width="${(W * f).toFixed(1)}" height="10" rx="5" fill="${BLUE}"/>`
  /* No total yet: a moving sheen says bytes are flowing. */
  const sheen =
    f === undefined
      ? `<rect x="-120" y="0" width="120" height="10" rx="5" fill="${SKY}" opacity=".7"><animate attributeName="x" values="-120;${W}" dur="1.4s" repeatCount="indefinite"/></rect>`
      : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 10" width="${W}" height="10">` +
    `<defs><clipPath id="pb"><rect width="${W}" height="10" rx="5"/></clipPath></defs>` +
    `<g clip-path="url(#pb)"><rect width="${W}" height="10" fill="#13305a"/>${fill}${sheen}</g>` +
    `</svg>`
  )
}

/* ---------- three numbers that mean something ---------- */

/** Steps that change what is on the server. */
const CHANGES = new Set(['deploy', 'upload', 'undo', 'rollback', 'delete', 'write', 'rename', 'mkdir'])

export type Tally = { sinceChange?: number; files: number; siteUp?: boolean; loadMs?: number }

/** `now` is the drawing's clock; "last change" counts across sessions, "files sent" this one. */
export function tallyOf(ops: Op[], now: number): Tally {
  const done = ops.filter(op => op.status !== 'running' && op.status !== 'error' && !op.isPreview)
  const files = done.filter(op => !op.isEarlier && (op.action === 'deploy' || op.action === 'upload')).reduce((n, op) => n + (op.files ?? 0), 0)
  const change = done.find(op => CHANGES.has(op.action))
  const lastCheck = ops.find(op => op.status !== 'running' && op.live !== undefined)
  return {
    sinceChange: change ? Math.max(0, now - (change.endedAt ?? change.startedAt)) : undefined,
    files,
    siteUp: lastCheck ? lastCheck.live !== 'down' : undefined,
    loadMs: lastCheck?.loadMs,
  }
}

/** "Now", "45s", "2 min", "3 h", "2 d": short enough for a tile. */
export function short(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 30) return 'Now'
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} d`
}

const loads = (ms: number) => `loads in ${(ms / 1000).toFixed(1)}s`

export function tallyAlt(t: Tally): string {
  const change = t.sinceChange === undefined ? 'No changes yet' : t.sinceChange < 30_000 ? 'Changed just now' : `Last change ${ago(t.sinceChange)}`
  const up = t.siteUp === undefined ? 'site not checked yet' : t.siteUp ? `site up${t.loadMs ? ', ' + loads(t.loadMs) : ''}` : 'site not answering'
  return `${change}, ${t.files} ${t.files === 1 ? 'file' : 'files'} sent, ${up}`
}

export function tallySvg(t: Tally): string {
  const tile = (x: number, value: string, label: string, color: string) =>
    `<rect x="${x}" y="2" width="136" height="60" rx="12" fill="#0f1f3a" stroke="#1f3a66"/>` +
    `<text x="${x + 68}" y="32" text-anchor="middle" font-size="22" font-weight="700" fill="${color}">${esc(value)}</text>` +
    `<text x="${x + 68}" y="51" text-anchor="middle" font-size="11" fill="${SOFT}">${esc(label)}</text>`
  const change =
    t.sinceChange === undefined ? ['None', 'changes yet', SOFT] : t.sinceChange < 30_000 ? ['Now', 'last change', INK] : [short(t.sinceChange), 'since last change', INK]
  const up =
    t.siteUp === undefined
      ? ['?', 'site not checked yet', SOFT]
      : t.siteUp
        ? ['Up', t.loadMs ? loads(t.loadMs) : 'site answering', GOOD]
        : ['Down', 'site not answering', BAD]
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 64" width="${W}" height="64" font-family="${FONT}">` +
    tile(2, change[0]!, change[1]!, change[2]!) +
    tile(152, String(t.files), t.files === 1 ? 'file sent' : 'files sent', INK) +
    tile(302, up[0]!, up[1]!, up[2]!) +
    `</svg>`
  )
}

/* ---------- one small icon per step ---------- */

const GLYPH: Record<Kind, string> = {
  publish: `<path d="M9,20 h14 a5,5 0 0 0 0,-10 a7,7 0 0 0 -13,-1 a5,5 0 0 0 -1,11 z" fill="none" stroke="#cfe6ff" stroke-width="2" stroke-linejoin="round"/><path d="M16,23 v-8 m-3,3 l3,-3 l3,3" fill="none" stroke="#cfe6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  send: `<path d="M16,23 v-14 m-5,5 l5,-5 l5,5 M9,25 h14" fill="none" stroke="#cfe6ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  fetch: `<path d="M16,9 v14 m-5,-5 l5,5 l5,-5 M9,25 h14" fill="none" stroke="#cfe6ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  check: `<path d="M6,17 h5 l3,-6 l4,12 l3,-6 h5" fill="none" stroke="#cfe6ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  look: `<circle cx="14" cy="14" r="6" fill="none" stroke="#cfe6ff" stroke-width="2.2"/><path d="M19,19 l5,5" stroke="#cfe6ff" stroke-width="2.6" stroke-linecap="round"/>`,
  restore: `<path d="M10,13 a7,7 0 1 1 1,8" fill="none" stroke="#cfe6ff" stroke-width="2.2" stroke-linecap="round"/><path d="M8,8 v6 h6" fill="none" stroke="#cfe6ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  remove: `<path d="M11,12 h10 l-1,12 h-8 z M9,11 h14 M14,8 h4" fill="none" stroke="#cfe6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  edit: `<path d="M10,22 l1,-4 l9,-9 l3,3 l-9,9 z" fill="none" stroke="#cfe6ff" stroke-width="2" stroke-linejoin="round"/>`,
}

export function iconSvg(op: Op): string {
  const kind = kindOf(op.action)
  const dot = op.status === 'ok' ? GOOD : op.status === 'warn' ? WARN : op.status === 'error' ? BAD : BLUE
  const fill = op.isEarlier ? '#16243c' : op.status === 'running' ? DEEP : NODE
  const pulse = op.status === 'running' ? `<animate attributeName="r" values="4;6;4" dur="1.2s" repeatCount="indefinite"/>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">` +
    `<circle cx="16" cy="16" r="15" fill="${fill}" stroke="${op.status === 'running' ? BLUE : '#1f3a66'}" stroke-width="1.5"/>` +
    GLYPH[kind] +
    `<circle cx="26" cy="26" r="5" fill="${dot}" stroke="#0b1730" stroke-width="2">${pulse}</circle>` +
    `</svg>`
  )
}
