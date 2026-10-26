import fs from "node:fs";
import path from "node:path";

/** Load .env from the project root if present. Uses Node's built-in loader; never throws if the file is absent. */
export function loadEnv(root: string = projectRoot()): void {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (e) {
    console.warn(`warning: could not load ${file}: ${(e as Error).message}`);
  }
}

/** Project root = directory containing package.json, walking up from this file. */
export function projectRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
