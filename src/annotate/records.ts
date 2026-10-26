import fs from "node:fs";
import path from "node:path";
import { readJsonl, writeJsonl } from "../util/jsonl.js";
import type { HandFile, RecordMeta, RecordRow, ReorderRow, SeamRow, TurnRow } from "./types.js";

export function recordsDir(root: string): string {
  return path.join(root, "records");
}

export function recordBase(root: string, id: string, slug: string): string {
  return path.join(recordsDir(root), `${id}-${slug}`);
}

/** Find an existing record by id prefix (e.g. "001"). */
export function findRecord(root: string, id: string): { base: string; id: string; slug: string } {
  const dir = recordsDir(root);
  if (!fs.existsSync(dir)) throw new Error(`no records directory at ${dir}`);
  const f = fs.readdirSync(dir).find((x) => x.startsWith(`${id}-`) && x.endsWith(".jsonl"));
  if (!f) throw new Error(`no record with id ${id} in ${dir} (run seam ingest first)`);
  const slug = f.slice(id.length + 1, -".jsonl".length);
  return { base: path.join(dir, `${id}-${slug}`), id, slug };
}

export interface LoadedRecord {
  meta: RecordMeta;
  turns: TurnRow[];
  seams: SeamRow[];
  reorder: ReorderRow[];
}

export function loadRecord(base: string): LoadedRecord {
  const rows = readJsonl<RecordRow>(`${base}.jsonl`);
  const meta = rows.find((r): r is RecordMeta => r.type === "meta");
  if (!meta) throw new Error(`${base}.jsonl has no meta row`);
  return {
    meta,
    turns: rows.filter((r): r is TurnRow => r.type === "turn"),
    seams: rows.filter((r): r is SeamRow => r.type === "seam"),
    reorder: rows.filter((r): r is ReorderRow => r.type === "reorder_suggestion"),
  };
}

export function saveRecord(base: string, rec: LoadedRecord): void {
  writeJsonl(`${base}.jsonl`, [rec.meta, ...rec.turns, ...rec.seams, ...rec.reorder]);
}

export function loadHandFile(base: string): HandFile | undefined {
  const f = `${base}.hand.json`;
  if (!fs.existsSync(f)) return undefined;
  return JSON.parse(fs.readFileSync(f, "utf8")) as HandFile;
}

/**
 * Copy the raw source next to the record. Raw sources are immutable: if a file
 * with the same name exists and differs, refuse rather than overwrite.
 */
export function preserveSource(root: string, id: string, slug: string, srcFile: string): string {
  const dir = path.join(recordsDir(root), "source");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${id}-${slug}${path.extname(srcFile) || ".txt"}`);
  const data = fs.readFileSync(srcFile);
  // Any existing source with the same id-slug stem, whatever its extension, must be byte-identical.
  const existing = fs.readdirSync(dir).filter((f) => f.startsWith(`${id}-${slug}.`));
  for (const f of existing) {
    const p = path.join(dir, f);
    if (!fs.readFileSync(p).equals(data)) {
      throw new Error(`${p} already exists with different content; raw sources are immutable. Use a new --id, or delete it deliberately.`);
    }
    return p;
  }
  fs.writeFileSync(dest, data);
  return dest;
}
