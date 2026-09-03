import { execFileSync } from "node:child_process";
import type { GitInfo } from "./types.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Returns git info for a directory, or undefined when it is not inside a repo. */
export function gitInfo(cwd: string): GitInfo | undefined {
  try {
    const commit = git(cwd, ["rev-parse", "HEAD"]);
    const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const subject = git(cwd, ["log", "-1", "--format=%s"]);
    const dirty = git(cwd, ["status", "--porcelain"]).length > 0;
    return { commit, short: commit.slice(0, 7), branch, subject, dirty };
  } catch {
    return undefined;
  }
}

/** Resolve a ref (branch, tag, short hash) to a full commit hash, or undefined. */
export function gitRevParse(cwd: string, ref: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    return undefined;
  }
}

/** Check out a commit into a separate directory without touching the working tree. */
export function gitWorktreeAdd(cwd: string, dir: string, commit: string): void {
  git(cwd, ["worktree", "add", "--detach", dir, commit]);
}

export function gitWorktreeRemove(cwd: string, dir: string): void {
  try {
    git(cwd, ["worktree", "remove", "--force", dir]);
  } catch {
    /* best effort; git worktree prune cleans up later */
  }
}

/** Stage everything and commit. Returns the new commit hash, or undefined when nothing to commit. */
export function gitCommitAll(cwd: string, message: string): string | undefined {
  try {
    git(cwd, ["add", "-A"]);
    if (git(cwd, ["status", "--porcelain"]).length === 0) return undefined;
    git(cwd, ["commit", "-m", message]);
    return git(cwd, ["rev-parse", "HEAD"]);
  } catch (e) {
    throw new Error(`git commit failed: ${(e as Error).message}`);
  }
}
