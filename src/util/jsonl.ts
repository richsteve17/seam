import fs from "node:fs";
import path from "node:path";

/** Append one row to a JSONL file. Rows are never rewritten; files are append-only. */
export function appendJsonl(file: string, row: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

export function readJsonl<T = unknown>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as T;
      } catch (e) {
        throw new Error(`${file}:${i + 1}: invalid JSON (${(e as Error).message})`);
      }
    });
}

/** Write a complete JSONL file (used for derived artefacts such as annotation records, never for trials). */
export function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

export function listJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => path.join(dir, f));
}
