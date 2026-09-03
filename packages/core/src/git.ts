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
