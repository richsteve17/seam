import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface PreregStatus {
  exists: boolean;
  committed: boolean;
  clean: boolean;      // no uncommitted edits to PREREG.md
  commit: string | null;
}

export function preregStatus(root: string): PreregStatus {
  const file = path.join(root, "PREREG.md");
  const exists = fs.existsSync(file);
  let commit: string | null = null;
  let clean = false;
  try {
    commit = execFileSync("git", ["log", "-1", "--format=%H", "--", "PREREG.md"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    const status = execFileSync("git", ["status", "--porcelain", "--", "PREREG.md"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    clean = status.length === 0;
  } catch {
    commit = null;
  }
  return { exists, committed: commit !== null, clean, commit };
}
