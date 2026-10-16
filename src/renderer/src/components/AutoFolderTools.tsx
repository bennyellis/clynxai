import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import type { ProductImage, ProductProfile } from "../lib/api.js";
import { Modal } from "./Modal.js";
import { doLibraryOp } from "./LibraryTools.js";
import { autoFolderId, autoPath } from "../../../main/folderKeys.js";

// Rename, delete and picture controls for Clynx's AUTOMATIC Library folders. All of it goes through the same backend call as the chat (api.libraryOp -> libraryOps.ts), so
// "rename Nintendo Consoles" in chat and the menu here are one rule. A folder's name and picture are stored against its full path, so they survive restarts and research
// refreshes; a picture you choose is never replaced by Clynx.

export type FolderMeta = Awaited<ReturnType<typeof api.libraryFolderMeta>>[number];

/** The automatic folders' settings, kept current: reloaded whenever the Library changes. */
export function useFolderMeta(): Map<string, FolderMeta> {
  const [meta, setMeta] = useState<Map<string, FolderMeta>>(new Map());
  const load = useCallback(() => {
    api.libraryFolderMeta().then((rows) => setMeta(new Map(rows.map((r) => [r.id, r]))));
  }, []);
  useEffect(() => {
    load();
    const off = api.onLibraryChanged(() => load());
    return () => {
      off();
    };
  }, [load]);
  return meta;
}

export function folderMetaFor(meta: Map<string, FolderMeta>, category: string, segments: string[]): FolderMeta | null {
  return meta.get(autoFolderId(category, segments)) ?? null;
}

/** The name shown for the folder at the end of `segments` (the person's rename, else the automation's word). */
export function folderLabel(meta: Map<string, FolderMeta>, category: string, segments: string[]): string {
  return folderMetaFor(meta, category, segments)?.displayName || segments[segments.length - 1] || category;
}

const SOURCE_NOTE: Record<string, string> = {
  ai_generated: "✨ Generated artwork (decorative)",
  auto: "📷 Picked from this folder's products",
  user_upload: "🖼 Your picture",
  user_selected: "🖼 Your choice",
  placeholder: "Placeholder",
};
export const pictureNote = (m: FolderMeta | null): string | null => (m?.thumbData && m.thumbSource ? (SOURCE_NOTE[m.thumbSource] ?? null) : null);

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read that file."));
    r.readAsDataURL(file);
  });
}

type Dialog = null | "rename" | "delete" | "pick";

export function AutoFolderMenu({
  category,
  segments,
  items,
  meta,
  compact = false,
}: {
  category: string;
  segments: string[];
  /** Every product in this folder (and below). */
  items: ProductProfile[];
  meta: Map<string, FolderMeta>;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const key = autoPath(category, segments);
  const m = folderMetaFor(meta, category, segments);
  const label = folderLabel(meta, category, segments);

  async function generate() {
    setOpen(false);
    setBusy("Making a picture…");
    const r = await api.generateFolderThumbnail(key);
    setBusy(null);
    window.dispatchEvent(new CustomEvent("clynx:library-note", { detail: { text: r.ok ? r.summary : (r.error ?? "That didn't work."), opId: undefined } }));
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      window.dispatchEvent(new CustomEvent("clynx:library-note", { detail: "That picture is too large (12 MB at most)." }));
      return;
    }
    setBusy("Saving…");
    try {
      const dataUri = await readFile(file);
      const r = await api.uploadFolderThumbnail(key, dataUri, file.name);
      window.dispatchEvent(new CustomEvent("clynx:library-note", { detail: { text: r.ok ? r.summary : (r.error ?? "That didn't work."), opId: r.opId } }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent("clynx:library-note", { detail: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  const item = (text: string, onClick: () => void, danger = false) => (
    <button
      className="icon ghost"
      style={{ justifyContent: "flex-start", width: "100%", textAlign: "left", color: danger ? "var(--danger)" : undefined }}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        onClick();
      }}
    >
      {text}
    </button>
  );

  return (
    <span style={{ position: "relative", display: "inline-block" }} onClick={(e) => e.stopPropagation()}>
      <button className="icon ghost" title="Rename, picture and delete" disabled={!!busy} style={compact ? { padding: "0 6px", minWidth: 0 } : undefined} onClick={() => setOpen((v) => !v)}>
        {busy ?? "⋯"}
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", right: 0, top: "100%", zIndex: 30, minWidth: 230, padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>
          {item("✏️ Rename folder…", () => setDialog("rename"))}
          {item("✨ Make a picture with Clynx", generate)}
          {item("🖼 Upload a picture…", () => fileRef.current?.click())}
          {item("📷 Choose from this folder's photos…", () => setDialog("pick"))}
          {m?.thumbData && item("↺ Use automatic pictures again", () => void doLibraryOp({ op: "restoreFolderThumbnail", key }))}
          {item("🗑 Delete folder…", () => setDialog("delete"), true)}
          {pictureNote(m) && <div style={{ fontSize: 12.5, color: "var(--text-dim)", padding: "4px 8px" }}>{pictureNote(m)}</div>}
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
      {dialog === "rename" && <RenameDialog keyPath={key} current={label} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteDialog keyPath={key} label={label} count={items.length} onClose={() => setDialog(null)} />}
      {dialog === "pick" && <PickDialog keyPath={key} items={items} onClose={() => setDialog(null)} />}
    </span>
  );
}

function RenameDialog({ keyPath, current, onClose }: { keyPath: string; current: string; onClose: () => void }) {
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    setError(null);
    const r = await doLibraryOp({ op: "renameAutoFolder", key: keyPath, name });
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error ?? "That didn't work.");
  }
  return (
    <Modal title="Rename folder" onClose={onClose}>
      <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)", lineHeight: 1.5 }}>Only the name changes. Its products, subfolders and picture stay put, and Clynx will keep using your name.</p>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && go()} />
      {error && <div style={{ color: "var(--danger)", fontSize: 13.5 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="icon" style={{ flex: 1 }} onClick={onClose}>
          Cancel
        </button>
        <button className="primary" style={{ flex: 1 }} disabled={busy || !name.trim()} onClick={go}>
          Rename
        </button>
      </div>
    </Modal>
  );
}

function DeleteDialog({ keyPath, label, count, onClose }: { keyPath: string; label: string; count: number; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go(mode: "move_contents_up" | "trash_with_contents") {
    setBusy(true);
    setError(null);
    const r = await doLibraryOp({ op: "deleteAutoFolder", key: keyPath, mode });
    setBusy(false);
    if (r.ok) onClose();
    else if (r.error && r.error !== "Cancelled.") setError(r.error);
  }
  return (
    <Modal title={`Delete the folder "${label}"?`} onClose={onClose}>
      <p style={{ margin: 0, fontSize: 14.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
        It holds {count} product{count === 1 ? "" : "s"}. Nothing is erased: choose where they go. Either choice can be undone, and the Trash keeps things for 30 days.
      </p>
      {error && <div style={{ color: "var(--danger)", fontSize: 13.5 }}>{error}</div>}
      <button className="primary" disabled={busy} onClick={() => go("move_contents_up")}>
        Move its contents to the parent folder
      </button>
      <button className="danger-solid" disabled={busy} onClick={() => go("trash_with_contents")}>
        Move the folder and its {count} product{count === 1 ? "" : "s"} to the Trash
      </button>
      <button className="icon" onClick={onClose}>
        Cancel
      </button>
    </Modal>
  );
}

function PickDialog({ keyPath, items, onClose }: { keyPath: string; items: ProductProfile[]; onClose: () => void }) {
  const [photos, setPhotos] = useState<Array<ProductImage & { productName: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(items.slice(0, 12).map((p) => api.listProductImages(p.id).then((imgs) => imgs.slice(0, 4).map((i) => ({ ...i, productName: p.name })))))
      .then((rows) => live && setPhotos(rows.flat().filter((i) => i.imageData && (i.status === undefined || i.status === "trusted" || i.status === "user" || i.status === "legacy"))))
      .catch(() => live && setPhotos([]));
    return () => {
      live = false;
    };
  }, [items]);
  async function choose(imageId: string) {
    const r = await doLibraryOp({ op: "setFolderThumbnail", key: keyPath, imageId });
    if (r.ok) onClose();
    else setError(r.error ?? "That didn't work.");
  }
  return (
    <Modal title="Choose a picture for this folder" onClose={onClose} width={640}>
      {photos === null && <div style={{ color: "var(--text-dim)" }}>Loading…</div>}
      {photos?.length === 0 && <div style={{ color: "var(--text-dim)" }}>None of this folder's products has a usable photo yet.</div>}
      {error && <div style={{ color: "var(--danger)", fontSize: 13.5 }}>{error}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8, maxHeight: "55vh", overflowY: "auto" }}>
        {photos?.map((p) => (
          <button key={p.id} className="icon ghost" title={p.productName} style={{ padding: 0, height: 110 }} onClick={() => choose(p.id)}>
            <img src={p.imageData} alt={p.productName} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 8 }} />
          </button>
        ))}
      </div>
    </Modal>
  );
}
