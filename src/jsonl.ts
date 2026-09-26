import { readFileSync } from "node:fs";

/** One JSON value per line; blank lines are skipped. */
export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}
