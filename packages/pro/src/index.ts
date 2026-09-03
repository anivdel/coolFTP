/*
 * coolFTP Pro. Proprietary; see packages/pro/LICENSE.
 * The build resolves "@coolftp/pro" to this file when the directory exists and to
 * packages/core/src/pro-stub.ts otherwise, so the open-source half builds on its own.
 */
export const PRO_AVAILABLE = true;

/** Names the app and CLI use to describe what Pro unlocks. */
export const PRO_FEATURES: Array<{ id: string; name: string; summary: string }> = [
  { id: "environments", name: "Environments", summary: "Deploy to staging, then promote exactly that to production." },
  { id: "notifications", name: "Deploy notifications", summary: "Slack, Discord, or a webhook on every deploy, with the commit and the verification result." },
  { id: "protected-sites", name: "Protected sites", summary: "Sites that always require approval before a deploy, even from you." },
];
