// Moving from "use Clynx on this computer only" (beta local mode) to a Clynx account, ONLY when the person asks for it. The local data is COPIED, never moved or changed, so the way
// back is simply to use local mode again; a folder the account already had is set aside, never overwritten.
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LOCAL_USER_ID = "local-beta";

export type ImportResult =
  | { copied: true; from: string; to: string; keptPrevious: string | null }
  | { copied: false; reason: string };

const hasData = (dir: string) => {
  try {
    return statSync(path.join(dir, "scout.db")).size > 0;
  } catch {
    return false;
  }
};

export function localDataExists(usersRoot: string): boolean {
  return hasData(path.join(usersRoot, LOCAL_USER_ID));
}

export function importLocalData(usersRoot: string, targetUserId: string, now: () => number = Date.now): ImportResult {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(targetUserId) || targetUserId === LOCAL_USER_ID) return { copied: false, reason: "That account cannot receive local data." };
  const src = path.join(usersRoot, LOCAL_USER_ID);
  const dst = path.join(usersRoot, targetUserId);
  if (!hasData(src)) return { copied: false, reason: "There is no local beta data to copy." };
  // never merge into data that is already there: the account's own history on this computer is not touched
  if (hasData(dst)) return { copied: false, reason: "This account already has its own data on this computer, so nothing was copied." };
  const stamp = now();
  const tmp = path.join(usersRoot, `.import-${targetUserId}-${stamp}`);
  try {
    // the old backups stay with the local copy; everything else (Database, settings, the Facebook browser profile) comes along
    cpSync(src, tmp, { recursive: true, filter: (p) => path.basename(p) !== "backups" });
    writeFileSync(path.join(tmp, "imported-from-local.json"), JSON.stringify({ importedAt: new Date(stamp).toISOString(), from: LOCAL_USER_ID }, null, 2));
    let keptPrevious: string | null = null;
    if (existsSync(dst)) {
      keptPrevious = `${dst}.before-import-${stamp}`;
      renameSync(dst, keptPrevious);
    }
    mkdirSync(path.dirname(dst), { recursive: true });
    renameSync(tmp, dst);
    return { copied: true, from: src, to: dst, keptPrevious };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    return { copied: false, reason: `The copy could not be completed (${(err as Error).message}); nothing was changed.` };
  }
}
