// What the user sees when opening their data fails at login (a damaged database that cannot be moved aside, a full disk, a locked folder).
// Without this the login call simply rejected and the window stayed on "Loading..." with nothing to do. Plain words, the folder to look
// at, and the one thing to try; the technical detail goes to the console log only.
export interface StartupProblem {
  kind: "database-locked" | "disk-full" | "permission" | "unknown";
  title: string;
  message: string;
  // The user's data folder, so "Show data folder" has somewhere to go (null when unknown).
  folder: string | null;
}

/** A damaged database that could not be moved aside (or whose replacement could not be started). Nothing was deleted. */
export class DatabaseRecoveryError extends Error {
  constructor(message: string, readonly damagedCopy: string | null, readonly cause: unknown) {
    super(message);
    this.name = "DatabaseRecoveryError";
  }
}

function codeOf(err: unknown): string {
  const direct = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof direct === "string") return direct;
  const nested = (err as { cause?: NodeJS.ErrnoException } | undefined)?.cause?.code;
  return typeof nested === "string" ? nested : "";
}

export function describeStartupFailure(err: unknown, dataFolder: string | null): StartupProblem {
  const code = codeOf(err);
  const raw = err instanceof Error ? err.message : String(err);
  const nothingLost = "Nothing was deleted.";
  if (code === "ENOSPC" || /no space left|disk is full/i.test(raw)) {
    return {
      kind: "disk-full",
      title: "Your disk is full",
      message: `Clynx can't open your data because there is no free space left on the drive it is stored on. Free up some space (empty the Recycle Bin, remove large files), then click Try again. ${nothingLost}`,
      folder: dataFolder,
    };
  }
  if (err instanceof DatabaseRecoveryError || code === "EBUSY" || code === "EPERM" || code === "EACCES") {
    const damaged = err instanceof DatabaseRecoveryError;
    return {
      kind: damaged || code === "EBUSY" ? "database-locked" : "permission",
      title: damaged ? "Clynx found a damaged database but couldn't move it aside" : "Clynx can't open your data files",
      message:
        `Another program is probably holding the file open, most often antivirus, a backup tool, or a second copy of Clynx. ` +
        `Close other programs that might be using Clynx's data folder (or restart your computer), then click Try again. ${nothingLost}` +
        (damaged && err.damagedCopy ? ` A copy of the damaged database was saved as ${err.damagedCopy.split(/[\\/]/).pop()}.` : ""),
      folder: dataFolder,
    };
  }
  return {
    kind: "unknown",
    title: "Clynx couldn't open your data",
    message: `Something went wrong while opening your data${raw ? ` (${raw.split("\n")[0].slice(0, 140)})` : ""}. Click Try again. If it keeps happening, restart Clynx; your files in the data folder have not been changed or deleted by this.`,
    folder: dataFolder,
  };
}
