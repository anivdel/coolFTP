# Claude Code Toolkit: long-form upsell video script

For the video at the top of each app's `upgrade.html`, the page a buyer sees after clicking "Buy Pro ($49)" and before checkout.

## Length: about 4 minutes

- Wistia's numbers say engagement barely changes from 1 to 5 minutes (about 48–50% watched), then drops sharply past 5. So up to 5 minutes costs almost nothing in attention, and buys a lot of explaining.
- Sales and product walkthroughs do best in the 2–5 minute range. Our 48-second cut is a teaser: it shows four logos but never says what Pro unlocks in each app, so a buyer can't tell what $99 gets them.
- The Toolkit is sold only on this page (it is not on the pricing sections), so "you'll only see this offer here" is true.
- No refund or guarantee is offered or mentioned anywhere: the Free tier, with every feature, is how people try before they buy.
- Upsell guidance agrees on three things: say the offer and the price early, keep the button on screen the whole time, and always give a clear "no thanks". The offer does most of the work and the script does the rest, so the script's main job is to make the offer easy to understand.
- **Target: about 4:00 (about 620 spoken words at 150 words a minute), in chapters.** The price and the button appear in the first 20 seconds and come back at the end. Someone who leaves at 1:00 has still heard the offer.
- Keep the 48-second video as a short version (for social posts, the top of the pricing section, and A/B tests against this one).

Sources: [Wistia, optimal video length](https://wistia.com/blog/optimal-video-length) · [Wistia, 2024 State of Video insights](https://wistia.com/blog/insights-state-of-video-report) · [Wistia, 2022 State of Video](https://wistia.com/about/state-of-video-2022) · [Process Street upsell script template](https://www.process.st/templates/the-upsell-creation-process/) · [Miles Beckler, one-click upsell script](https://milesbeckler.com/one-click-upsell-script-template) · [PayKickstart, upsell page elements](https://paykickstart.com/?p=4315)

## On screen the whole time

A small bar along the bottom: **"Claude Code Toolkit · all four apps · $99 one-time (was $196)"**, with the four logos. The page's green "Yes! Give me the full Toolkit" button sits right below the video, so a buyer can say yes at any point.

## Chapters

| # | Time | Chapter |
|---|---|---|
| 1 | 0:00–0:25 | You picked one. Here's the offer. |
| 2 | 0:25–0:55 | The problem: Claude is working blind |
| 3 | 0:55–1:35 | magpieSnap: Claude sees your screen |
| 4 | 1:35–2:10 | woodpeckerDig: Claude reads your errors |
| 5 | 2:10–2:45 | OwlSQL: Claude fixes your data, safely |
| 6 | 2:45–3:15 | coolFTP: Claude ships it |
| 7 | 3:15–3:40 | Exactly what you get |
| 8 | 3:40–4:00 | Quick answers, the offer, and your out |

---

## 1 · You picked one. Here's the offer. (0:00–0:25)

**On screen:** "✓ [App] Pro picked". The four logos slide in, then a price card: $196 crossed out, **$99**, "Save $97".

**VO:**
> You just picked one of our apps. Good choice. Before you check out, here's an offer you'll only see on this page in the checkout flow. For fifty dollars more, you can get all four of our Claude Code apps instead of one. That's ninety-nine dollars for the full Toolkit, instead of a hundred and ninety-six. Give me four minutes and I'll show you exactly what each one does, and why they work best together.

## 2 · The problem: Claude is working blind (0:25–0:55)

**On screen:** a split screen. On the left, a person copying a stack trace, taking a screenshot, opening phpMyAdmin and dragging files into FTP. On the right, Claude waiting: "Can you paste the error?"

**VO:**
> Claude Code is brilliant at writing code. But it can't see your screen, it can't see your program crash, it can't touch your database, and it can't put your site live. So you end up as the go-between, pasting screenshots, copying stack traces, running queries by hand and uploading files. Each of these four apps removes one of those jobs, and each one does it safely.

## 3 · magpieSnap: Claude sees your screen (0:55–1:35)

**On screen:** the existing magpieSnap scene, slower. Print Screen, box the cut-off price, type a note, Enter. The card shows "Sent to Claude in my-shop", then Claude: "Fixed: the price no longer wraps", then a Windows notification: "Claude fixed it".

**VO:**
> magpieSnap is how you show Claude a problem. Press Print Screen, drag a box around it, type a note, and press Enter. Claude gets the close-up, the whole screen with your box marked, and which app and window it came from. No saving files, no dragging, no pasting. When Claude has fixed it, you get a notification telling you what changed. Free sends captures to one project. Pro sends them to every project you work on.

## 4 · woodpeckerDig: Claude reads your errors (1:35–2:10)

**On screen:** `woodpecker run npm run dev`, the dev server crashes, an issue card "TypeError in src/cart.js:42 · seen 3 times" appears, the tray icon turns red, then Claude: "Read the trace. Fixed src/cart.js:42."

**VO:**
> Some bugs you can't screenshot. A crash in your dev server, an error in the browser console, a game that just closes. woodpeckerDig records what your programs print, finds the crashes and stack traces, groups repeats into one issue, and points at the exact file and line. Then you just tell Claude "it's broken". It already has the trace. Free covers one project. Pro covers every project.

## 5 · OwlSQL: Claude fixes your data, safely (2:10–2:45)

**On screen:** the OwlSQL scene: misspelled categories, the UPDATE, rows turn green, "3 rows changed · snapshot saved · undo available". Then a quick cut to the approval dialog: "DELETE without WHERE: Allow / Deny".

**VO:**
> When the bug is in your data, OwlSQL lets Claude work on your real MySQL or MariaDB database, even on shared hosting. It's read-only until you switch writes on. Every write is snapshotted first, so "undo that" puts it back. Anything risky, like a delete without a where clause, waits for you to click Allow. Free covers one database. Pro covers all of them.

## 6 · coolFTP: Claude ships it (2:45–3:15)

**On screen:** the coolFTP scene: three changed files upload, "✔ live · 200 https://myshop.com", then "undo restores the previous versions".

**VO:**
> And when it's fixed, coolFTP puts it live. Claude deploys to any SFTP or FTP host, like Hostinger, GoDaddy, cPanel or your own server. Only the files that changed go up. The site is checked afterwards to prove it's live, and if something's wrong, one undo brings the old version back. No git needed. Free covers one site. Pro covers unlimited sites.

## 7 · Exactly what you get (3:15–3:40)

**On screen:** a clear table, one row per app.

| App | Free | With the Toolkit |
|---|---|---|
| magpieSnap | 1 project | Every project |
| woodpeckerDig | 1 project | Every project |
| OwlSQL | 1 database | Unlimited databases |
| coolFTP | 1 site | Unlimited sites |

Under the table: "One key unlocks all four · Up to 3 machines · Updates for life · Same downloads you already have".

**VO:**
> Here's exactly what ninety-nine dollars gets you: Pro for all four apps, for life. You get one license key by email, and it unlocks every app. Paste it into each app once, or just ask Claude to activate it. Each app keeps every feature it already has, and the limits go away: every project, every database, unlimited sites. It works on up to three of your machines, with updates for life. No subscription, nothing to renew.

## 8 · Quick answers, the offer, and your out (3:40–4:00)

**On screen:** four quick answers appear one after another. Then the price card again, with the green button glowing, and the "No thanks" link underneath.

- **Do I need all four?** You'll use magpieSnap and woodpeckerDig every day, OwlSQL whenever a site has a database, and coolFTP every time you ship.
- **What do I need?** Windows 10 or 11 and Claude Code. coolFTP and OwlSQL also work with Cursor and Codex.
- **Is it a subscription?** No. You pay once and get updates for life.
- **Will it work with my hosting?** Yes. coolFTP works with any SFTP or FTP host, and OwlSQL with any MySQL or MariaDB, including Hostinger, GoDaddy and cPanel.

**VO:**
> Four apps that give Claude eyes, ears, your database and a way to ship. That's normally a hundred and ninety-six dollars, and today it's ninety-nine, once, for life. Click the green button below to get the full Toolkit. And if you'd rather keep it simple, the link under it gets you just the one app you picked, for forty-nine. Either way, thanks for supporting this. Now go let Claude do the busy work.

---

## Production notes

- **Word count:** about 560 spoken words, which is about 3:50 at Andrew +6%, or about 4:00 with pauses between chapters. Trim chapter 2 first if it runs long.
- **Reuse:** chapters 3–6 reuse the four existing scenes from `toolkit.html`, stretched to 30–40 seconds each, with extra beats (the "Claude fixed it" notification, the red tray icon, the approval dialog). Chapters 1, 2, 7 and 8 are new: the price card, the split screen, the comparison table and the quick answers.
- **Chapters:** add chapter markers to the player, so a buyer who only cares about one app can jump straight to it.
- **Pronunciation:** the TTS needs the app names spelled out in the narration file, as in `lines.cjs`: "magpie snap", "woodpecker dig", "Owl S Q L", "cool F T P".
- **A/B test:** run the 4-minute version against the 48-second one for a couple of weeks and compare Toolkit purchases per upsell-page view.
