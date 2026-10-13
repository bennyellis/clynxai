// The identity safeguard's decision log: one JSON line per decision in <userData>/logs/identity-safeguard.jsonl (shadow mode: every evaluated match; enforce mode: every
// veto). Capped at 2 MB (the older half is kept as .old). Never throws: logging must not matter to a scan.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

export function createSafeguardLogger(dir: string): (record: Record<string, unknown>) => void {
  const file = path.join(dir, "identity-safeguard.jsonl");
  return (record) => {
    try {
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, file + ".old");
      } catch {
        /* no file yet */
      }
      appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      /* ignore */
    }
  };
}
