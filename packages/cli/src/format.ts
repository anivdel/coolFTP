import type { DiffPlan } from "@coolftp/core";

/** Show the first `max` entries and say how many follow. */
export function capList<T>(items: T[], max = 20): Array<T | string> {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `… and ${items.length - max} more`];
}

/**
 * Where a long list of paths lives, as "folder/: count" pairs sorted by count. When one folder
 * holds most of the files, it is broken down one level further so the picture stays useful
 * ("assets/cards/1999/: 350" rather than "assets/: 11,000").
 */
export function groupByDir(files: string[], max = 8): Array<[string, number]> {
  const count = (list: string[], depth: number) => {
    const m = new Map<string, number>();
    for (const f of list) {
      const parts = f.split("/");
      const key = parts.length > depth ? parts.slice(0, depth).join("/") + "/" : "(root)";
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  };
  let groups = count(files, 1);
  for (let depth = 2; depth <= 4; depth++) {
    const top = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top || top[0] === "(root)" || top[1] < 50 || top[1] / files.length < 0.5) break;
    const inside = files.filter((f) => f.startsWith(top[0]));
    const deeper = count(inside, depth);
    if (deeper.size < 2) break;
    groups.delete(top[0]);
    for (const [k, v] of deeper) groups.set(k, v);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (sorted.length <= max) return sorted;
  const rest = sorted.slice(max).reduce((n, [, v]) => n + v, 0);
  return [...sorted.slice(0, max), [`… ${sorted.length - max} more folders`, rest]];
}

export interface CompactPlan {
  basis: DiffPlan["basis"];
  counts: { add: number; change: number; delete: number; unchanged: number };
  bytes: number;
  add: Array<string>;
  change: Array<string>;
  delete: Array<string>;
  folders?: { add?: Record<string, number>; change?: Record<string, number>; delete?: Record<string, number> };
}

/** A plan an agent can read without paging through thousands of paths. */
export function compactPlan(plan: DiffPlan, max = 20): CompactPlan {
  const out: CompactPlan = {
    basis: plan.basis,
    counts: { add: plan.add.length, change: plan.change.length, delete: plan.delete.length, unchanged: plan.unchanged },
    bytes: plan.bytes,
    add: capList(plan.add, max),
    change: capList(plan.change, max),
    delete: capList(plan.delete, max),
  };
  for (const key of ["add", "change", "delete"] as const) {
    if (plan[key].length > max) {
      out.folders ??= {};
      out.folders[key] = Object.fromEntries(groupByDir(plan[key]));
    }
  }
  return out;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
