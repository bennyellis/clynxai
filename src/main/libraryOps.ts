// Beta 13: ONE backend for everything a person (or the chat, on their behalf) does to the Library: folders, placing and renaming products, photos (add / remove / replace /
// reorder / primary / thumbnail), setting a photo aside or putting it back, and moving a photo to another product. The UI and the chat both call run(); there is no second copy
// of any rule. Every operation: validates (exists, not deleted, names, nesting depth, no cycles), runs in ONE write transaction, records an audit row with the old values of
// everything it touched (so undo is exact), and returns a plain summary. Delete is always a move to the Trash (30 days). Bulk or consequential operations answer
// "needsConfirmation" first and only run when the SAME operation comes back with the token it issued; the chat never sees the token (it presents the question to the person).
// Moving a product or a photo never changes what the product IS or what it is worth: only where it is shown, and which photos it holds.
import { randomBytes, randomUUID } from "node:crypto";
import { galleryConflict } from "./identityModel.js";
import { judgeCandidateByText } from "./photoIdentity.js";
import { autoFolderId, autoPath, cleanFolderLabel, isUserThumb, partsOfPath, splitPath, type ThumbSource } from "./folderKeys.js";
import { checkFolderImage } from "./folderArt.js";
import type { Store } from "./store.js";
import type { ProductImage } from "./types.js";

export type LibraryOp =
  | { op: "createFolder"; parentId: string | null; name: string }
  | { op: "renameFolder"; id: string; name: string }
  | { op: "moveFolder"; id: string; newParentId: string | null }
  | { op: "deleteFolder"; id: string; mode?: "move_contents_up" | "trash_with_contents" }
  | { op: "restoreFolder"; id: string }
  | { op: "moveProduct"; productId: string; folderId: string | null }
  | { op: "moveProducts"; productIds: string[]; folderId: string | null }
  | { op: "renameProduct"; id: string; name: string }
  | { op: "setProductCategory"; id: string; category: string }
  | { op: "trashProduct"; id: string }
  | { op: "restoreProduct"; id: string }
  | { op: "removeImage"; imageId: string }
  | { op: "restoreImage"; imageId: string }
  | { op: "replaceImage"; imageId: string; imageData: string }
  | { op: "reorderImages"; productId: string; orderedIds: string[] }
  | { op: "setPrimaryImage"; productId: string; imageId: string }
  | { op: "setThumbnail"; productId: string; imageId: string | null }
  | { op: "reassignImage"; imageId: string; toProductId: string }
  | { op: "keepImage"; imageId: string }
  | { op: "quarantineImage"; imageId: string }
  | { op: "resolveReview"; itemId: string; state: "accepted" | "rejected" | "snoozed" }
  | { op: "newEntryFromImage"; imageId: string; name: string }
  | { op: "mergeProducts"; ids: string[] }
  // The AUTOMATIC folders (category + family path, see folderKeys.ts). `key` is the folder's full path "Category > Folder > Subfolder".
  | { op: "renameAutoFolder"; key: string; name: string }
  | { op: "deleteAutoFolder"; key: string; mode?: "move_contents_up" | "trash_with_contents" }
  | { op: "setFolderThumbnail"; key: string; imageId?: string; imageData?: string; fileName?: string }
  | { op: "restoreFolderThumbnail"; key: string }
  // Used by the picture generator and the automatic chooser, never by a person's click: records a picture with where it came from.
  | { op: "recordFolderThumbnail"; key: string; imageData: string; source: "ai_generated" | "auto" | "placeholder"; meta?: Record<string, unknown>; byRequest?: boolean }
  | { op: "undo"; opId: string };

export interface OpResult {
  ok: boolean;
  summary: string;
  opId?: string;
  error?: string;
  /** Operation-specific results (e.g. the id of a product an operation created, so the caller can start its research). */
  data?: { productId?: string };
  needsConfirmation?: { token: string; prompt: string };
}

export interface OpContext {
  actor: "ui" | "chat" | "system";
  /** The token a previous call returned in needsConfirmation (UI only; the chat keeps it server-side). */
  confirm?: string;
}

/** "Parent > Child" paths of live folders with their ids (what the chat reads to find a folder). */
export function folderPathList(folders: Array<{ id: string; parentId: string | null; name: string }>): Array<{ id: string; path: string }> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  return folders
    .map((f) => {
      const parts: string[] = [];
      let cur: { id: string; parentId: string | null; name: string } | undefined = f;
      for (let i = 0; cur && i < 12; i++) {
        parts.unshift(cur.name);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return { id: f.id, path: parts.join(" > ") };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export const MAX_FOLDER_DEPTH = 8;
export const MAX_NAME_LENGTH = 80;
const RESERVED_ROOT_NAMES = new Set(["needs review", "trash", "my folders"]);
const BULK_CONFIRM_ABOVE = 10;
const TOKEN_TTL_MS = 10 * 60_000;
export const TRASH_RETENTION_MS = 30 * 24 * 3600_000;

type Snap = { table: "products" | "product_images" | "library_folders" | "folder_meta"; id: string; before: Record<string, unknown> };
type Created = { table: "products" | "product_images" | "library_folders" | "folder_meta"; id: string };

const nameKey = (n: string) => n.trim().replace(/\s+/g, " ").toLowerCase();
export function cleanName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "A name is needed." };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `Names can be at most ${MAX_NAME_LENGTH} characters.` };
  if (/[>\/\\\u0000-\u001f]/.test(name)) return { ok: false, error: 'A name cannot contain ">", "/", "\\" or control characters.' };
  return { ok: true, name };
}

export class LibraryOps {
  private pending = new Map<string, { key: string; expires: number }>();
  constructor(private readonly store: Store, private readonly onChanged: (what: { productIds: string[]; folders: boolean; review: boolean }) => void = () => {}) {}

  private get db() {
    return this.store.database;
  }

  /** Runs one operation. Never throws: a failure is {ok:false, error}. */
  run(operation: LibraryOp, ctx: OpContext): OpResult {
    try {
      if (operation.op === "undo") return this.undo(operation.opId, ctx);
      const need = this.confirmation(operation);
      if (need) {
        const key = JSON.stringify(operation);
        if (!ctx.confirm || !this.redeem(ctx.confirm, key)) {
          const token = randomBytes(12).toString("hex");
          this.pending.set(token, { key, expires: Date.now() + TOKEN_TTL_MS });
          return { ok: false, summary: need, needsConfirmation: { token, prompt: need } };
        }
      }
      if (operation.op === "mergeProducts") return this.merge(operation.ids, ctx);
      const snaps: Snap[] = [];
      const created: Created[] = [];
      const touched: { productIds: Set<string>; folders: boolean; review: boolean } = { productIds: new Set(), folders: false, review: false };
      let summary = "";
      this.store.transaction(() => {
        summary = this.apply(operation, snaps, created, touched);
      });
      const createdProduct = created.find((c) => c.table === "products")?.id;
      const opId = randomUUID();
      this.db
        .prepare("INSERT INTO library_ops (id, at, actor, op, args_json, inverse_json, batch_id) VALUES (?, ?, ?, ?, ?, ?, NULL)")
        .run(opId, Date.now(), ctx.actor, operation.op, JSON.stringify(operation), JSON.stringify({ snaps, created }));
      this.store.invalidateFolders();
      this.onChanged({ productIds: [...touched.productIds], folders: touched.folders, review: touched.review });
      return { ok: true, summary, opId, ...(createdProduct ? { data: { productId: createdProduct } } : {}) };
    } catch (err) {
      return { ok: false, summary: "", error: (err as Error).message };
    }
  }

  // Merging folds entries into one (their photos, listings and links move to the kept one; the others are deleted for good, as the Database always did). It is the one
  // operation History cannot undo, so it always asks first, and every photo it moves is re-checked afterwards: one the new entry's own title contradicts is set aside.
  private merge(ids: string[], ctx: OpContext): OpResult {
    const key = JSON.stringify({ op: "mergeProducts", ids });
    if (!ctx.confirm || !this.redeem(ctx.confirm, key)) {
      const token = randomBytes(12).toString("hex");
      const prompt = `Merge ${ids.length} entries into one? Their photos move to the kept entry and the others are deleted. This cannot be undone from History (a backup copy exists).`;
      this.pending.set(token, { key, expires: Date.now() + TOKEN_TTL_MS });
      return { ok: false, summary: prompt, needsConfirmation: { token, prompt } };
    }
    const merged = this.store.mergeDuplicateProducts(ids);
    if (merged.size === 0) return { ok: false, summary: "", error: "Those entries are not duplicates of each other." };
    let flagged = 0;
    for (const keptId of new Set(merged.values())) flagged += this.store.markSuspectImages({ all: true, productId: keptId }).flagged;
    const opId = randomUUID();
    this.db.prepare("INSERT INTO library_ops (id, at, actor, op, args_json, inverse_json) VALUES (?, ?, ?, 'mergeProducts', ?, NULL)").run(opId, Date.now(), ctx.actor, JSON.stringify({ ids }));
    this.store.invalidateFolders();
    this.onChanged({ productIds: [...merged.keys(), ...merged.values()], folders: false, review: true });
    return { ok: true, summary: `Merged ${merged.size + new Set(merged.values()).size} entries into ${new Set(merged.values()).size}.${flagged ? ` ${flagged} photo${flagged === 1 ? "" : "s"} did not fit and ${flagged === 1 ? "was" : "were"} set aside for review.` : ""}`, opId };
  }

  private redeem(token: string, key: string): boolean {
    const p = this.pending.get(token);
    this.pending.delete(token);
    for (const [t, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(t);
    return !!p && p.key === key && p.expires >= Date.now();
  }

  /** The question to ask first, or null when the operation is safe to run (small, local and undoable). */
  private confirmation(o: LibraryOp): string | null {
    if (o.op === "moveProducts" && o.productIds.length > BULK_CONFIRM_ABOVE) return `Move ${o.productIds.length} products?`;
    if (o.op === "deleteFolder") {
      const kids = this.countFolderContents(o.id);
      if (o.mode === "trash_with_contents" && (kids.products || kids.folders)) return `Send the folder and everything in it (${kids.products} product${kids.products === 1 ? "" : "s"}, ${kids.folders} subfolder${kids.folders === 1 ? "" : "s"}) to the Trash?`;
    }
    if (o.op === "deleteAutoFolder") {
      const n = this.autoMembers(o.key).length;
      if (o.mode === "trash_with_contents" && n) return `Send the folder "${splitPath(o.key).slice(-1)[0]}" and the ${n} product${n === 1 ? "" : "s"} in it to the Trash?`;
      if (n > BULK_CONFIRM_ABOVE) return `Move ${n} products up one level and remove the folder?`;
    }
    if (o.op === "replaceImage") return "Replace this photo? The old one goes to the Trash.";
    if (o.op === "reassignImage") {
      const img = this.store.getProductImage(o.imageId);
      const to = this.store.getProductById(o.toProductId);
      if (img && to) {
        const t = img.sourceTitle ? judgeCandidateByText(to.name, img.sourceTitle) : null;
        if (t?.status === "mismatch") return `This photo's title ("${img.sourceTitle}") says it is not "${to.name}" (${t.reasons[0]}). Move it there anyway?`;
        const conflict = img.sourceTitle ? galleryConflict(this.store.listReferenceTitles(to.id), img.sourceTitle) : null;
        if (conflict) return `This photo shows ${conflict}. Move it into "${to.name}" anyway?`;
      }
    }
    if (o.op === "renameProduct") {
      const p = this.store.getProductById(o.id);
      const c = cleanName(o.name);
      if (p && c.ok && p.name.toLowerCase() !== c.name.toLowerCase()) {
        const before = judgeCandidateByText(p.name, c.name);
        if (before.status === "mismatch") return `"${c.name}" reads as a different product than "${p.name}" (${before.reasons[0]}). Rename it anyway? Its prices and photos stay with it.`;
      }
    }
    return null;
  }

  private countFolderContents(folderId: string): { products: number; folders: number } {
    const all = this.store.listFolders();
    const ids = new Set<string>([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of all) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
    }
    const placeholders = [...ids].map(() => "?").join(",");
    const products = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM products WHERE deleted_at IS NULL AND folder_id IN (${placeholders})`).get(...ids) as { n: number }).n);
    return { products, folders: ids.size - 1 };
  }

  // ---- snapshots / validation helpers
  private snap(table: Snap["table"], id: string, cols: string[], snaps: Snap[]): void {
    if (snaps.some((s) => s.table === table && s.id === id)) return;
    const row = this.db.prepare(`SELECT ${cols.join(", ")} FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (row) snaps.push({ table, id, before: row });
  }
  private product(id: string) {
    const p = this.db.prepare("SELECT id, name, deleted_at, folder_id FROM products WHERE id = ?").get(id) as { id: string; name: string; deleted_at: number | null; folder_id: string | null } | undefined;
    if (!p) throw new Error("That product does not exist.");
    return p;
  }
  private folder(id: string) {
    const f = this.db.prepare("SELECT id, parent_id, name, name_key, deleted_at FROM library_folders WHERE id = ?").get(id) as { id: string; parent_id: string | null; name: string; name_key: string; deleted_at: number | null } | undefined;
    if (!f || f.deleted_at) throw new Error("That folder does not exist.");
    return f;
  }
  private image(id: string): ProductImage {
    const i = this.store.getProductImage(id);
    if (!i) throw new Error("That photo does not exist.");
    return i;
  }
  private depthOf(folderId: string | null): number {
    let d = 0;
    let cur = folderId;
    while (cur && d < 20) {
      const f = this.db.prepare("SELECT parent_id FROM library_folders WHERE id = ?").get(cur) as { parent_id: string | null } | undefined;
      if (!f) break;
      d++;
      cur = f.parent_id;
    }
    return d;
  }
  private subtreeHeight(folderId: string): number {
    const kids = this.db.prepare("SELECT id FROM library_folders WHERE parent_id = ? AND deleted_at IS NULL").all(folderId) as Array<{ id: string }>;
    return 1 + Math.max(0, ...kids.map((k) => this.subtreeHeight(k.id)));
  }
  private assertSiblingFree(parentId: string | null, key: string, exceptId?: string): void {
    const clash = this.db
      .prepare("SELECT id FROM library_folders WHERE COALESCE(parent_id, '') = ? AND name_key = ? AND deleted_at IS NULL AND id != ?")
      .get(parentId ?? "", key, exceptId ?? "") as { id: string } | undefined;
    if (clash) throw new Error("A folder with that name already exists here. Pick another name.");
  }
  private descendants(folderId: string): string[] {
    const out: string[] = [];
    const walk = (id: string) => {
      for (const k of this.db.prepare("SELECT id FROM library_folders WHERE parent_id = ? AND deleted_at IS NULL").all(id) as Array<{ id: string }>) {
        out.push(k.id);
        walk(k.id);
      }
    };
    walk(folderId);
    return out;
  }


  // ---- automatic folders
  /** The live, unplaced products on this automatic folder or anywhere under it. */
  private autoMembers(key: string): Array<{ id: string; name: string; category: string; family: string | null }> {
    const { category, segments } = partsOfPath(key);
    if (!category) return [];
    const want = segments.map((x) => x.toLowerCase());
    const rows = this.db.prepare("SELECT id, name, category, family FROM products WHERE deleted_at IS NULL AND folder_id IS NULL").all() as Array<{ id: string; name: string; category: string | null; family: string | null }>;
    return rows
      .map((r) => ({ id: r.id, name: r.name, category: r.category || "Other", family: r.family }))
      .filter((r) => {
        if (r.category.toLowerCase() !== category.toLowerCase()) return false;
        const have = splitPath(r.family ?? "").map((x) => x.toLowerCase());
        return want.every((w, i) => have[i] === w);
      });
  }
  /** The next-level folder names directly under a path, as the automation wrote them (for sibling name clashes). */
  private autoChildren(parentKey: string): string[] {
    const { category, segments } = partsOfPath(parentKey);
    const out = new Map<string, string>();
    for (const m of this.autoMembers(parentKey)) {
      const have = splitPath(m.family ?? "");
      const next = have[segments.length];
      if (next && category) out.set(next.toLowerCase(), next);
    }
    return [...out.values()];
  }
  private autoFolderOrThrow(key: string): { category: string; segments: string[]; id: string } {
    const { category, segments } = partsOfPath(key);
    if (!category || segments.length === 0) throw new Error("A top-level category cannot be changed this way. Pick a folder inside it.");
    if (this.autoMembers(key).length === 0) throw new Error("That folder does not exist (nothing is in it right now).");
    return { category, segments, id: autoFolderId(category, segments) };
  }
  private snapMeta(id: string, snaps: Snap[], created: Created[]): void {
    if (snaps.some((s) => s.table === "folder_meta" && s.id === id) || created.some((c) => c.table === "folder_meta" && c.id === id)) return;
    const row = this.db.prepare("SELECT display_name, thumb_data, thumb_source, thumb_meta, thumb_locked, updated_at FROM folder_meta WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (row) snaps.push({ table: "folder_meta", id, before: row });
    else created.push({ table: "folder_meta", id });
  }

  private apply(o: LibraryOp, snaps: Snap[], created: Created[], touched: { productIds: Set<string>; folders: boolean; review: boolean }): string {
    const now = Date.now();
    switch (o.op) {
      case "createFolder": {
        const n = cleanName(o.name);
        if (!n.ok) throw new Error(n.error);
        if (!o.parentId && RESERVED_ROOT_NAMES.has(nameKey(n.name))) throw new Error(`"${n.name}" is a reserved name.`);
        if (o.parentId) this.folder(o.parentId);
        if (this.depthOf(o.parentId) + 1 > MAX_FOLDER_DEPTH) throw new Error(`Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`);
        this.assertSiblingFree(o.parentId, nameKey(n.name));
        const id = randomUUID();
        const position = Number((this.db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM library_folders WHERE COALESCE(parent_id,'') = ?").get(o.parentId ?? "") as { p: number }).p);
        this.db.prepare("INSERT INTO library_folders (id, parent_id, name, name_key, position, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'user', ?, ?)").run(id, o.parentId, n.name, nameKey(n.name), position, now, now);
        created.push({ table: "library_folders", id });
        touched.folders = true;
        return `Created the folder "${n.name}".`;
      }
      case "renameFolder": {
        const f = this.folder(o.id);
        const n = cleanName(o.name);
        if (!n.ok) throw new Error(n.error);
        if (!f.parent_id && RESERVED_ROOT_NAMES.has(nameKey(n.name))) throw new Error(`"${n.name}" is a reserved name.`);
        this.assertSiblingFree(f.parent_id, nameKey(n.name), f.id);
        this.snap("library_folders", f.id, ["name", "name_key", "updated_at"], snaps);
        this.db.prepare("UPDATE library_folders SET name = ?, name_key = ?, updated_at = ? WHERE id = ?").run(n.name, nameKey(n.name), now, f.id);
        touched.folders = true;
        return `Renamed "${f.name}" to "${n.name}".`;
      }
      case "moveFolder": {
        const f = this.folder(o.id);
        if (o.newParentId) {
          this.folder(o.newParentId);
          if (o.newParentId === f.id || this.descendants(f.id).includes(o.newParentId)) throw new Error("A folder cannot be moved into itself or one of its own subfolders.");
        }
        if (this.depthOf(o.newParentId) + this.subtreeHeight(f.id) > MAX_FOLDER_DEPTH) throw new Error(`That would nest folders more than ${MAX_FOLDER_DEPTH} levels deep.`);
        if (!o.newParentId && RESERVED_ROOT_NAMES.has(f.name_key)) throw new Error(`"${f.name}" is a reserved name at the top level.`);
        this.assertSiblingFree(o.newParentId, f.name_key, f.id);
        this.snap("library_folders", f.id, ["parent_id", "updated_at"], snaps);
        this.db.prepare("UPDATE library_folders SET parent_id = ?, updated_at = ? WHERE id = ?").run(o.newParentId, now, f.id);
        touched.folders = true;
        return `Moved the folder "${f.name}".`;
      }
      case "deleteFolder": {
        const f = this.folder(o.id);
        const subtree = [f.id, ...this.descendants(f.id)];
        const mode = o.mode ?? "move_contents_up";
        const rows = this.db.prepare(`SELECT id FROM products WHERE deleted_at IS NULL AND folder_id IN (${subtree.map(() => "?").join(",")})`).all(...subtree) as Array<{ id: string }>;
        for (const p of rows) {
          this.snap("products", p.id, ["folder_id", "deleted_at", "updated_at"], snaps);
          touched.productIds.add(p.id);
        }
        if (mode === "trash_with_contents") {
          for (const p of rows) this.db.prepare("UPDATE products SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, p.id);
          for (const id of subtree) {
            this.snap("library_folders", id, ["deleted_at", "updated_at"], snaps);
            this.db.prepare("UPDATE library_folders SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
          }
        } else {
          // contents (products and subfolders) move up to this folder's parent; then only this folder goes to the Trash
          for (const p of rows) this.db.prepare("UPDATE products SET folder_id = ? WHERE id = ?").run(f.parent_id, p.id);
          const kids = this.db.prepare("SELECT id, name_key FROM library_folders WHERE parent_id = ? AND deleted_at IS NULL").all(f.id) as Array<{ id: string; name_key: string }>;
          for (const k of kids) {
            this.assertSiblingFree(f.parent_id, k.name_key, k.id);
            this.snap("library_folders", k.id, ["parent_id", "updated_at"], snaps);
            this.db.prepare("UPDATE library_folders SET parent_id = ?, updated_at = ? WHERE id = ?").run(f.parent_id, now, k.id);
          }
          this.snap("library_folders", f.id, ["deleted_at", "updated_at"], snaps);
          this.db.prepare("UPDATE library_folders SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, f.id);
        }
        touched.folders = true;
        return mode === "trash_with_contents" ? `Sent "${f.name}" and its contents to the Trash.` : `Removed the folder "${f.name}"; what was inside moved up one level.`;
      }
      case "renameAutoFolder": {
        const f = this.autoFolderOrThrow(o.key);
        const n = cleanFolderLabel(o.name);
        if (!n.ok) throw new Error(n.error);
        const original = f.segments[f.segments.length - 1];
        const parentKey = autoPath(f.category, f.segments.slice(0, -1));
        const shown = (child: string) => this.store.getFolderMeta(autoFolderId(f.category, [...f.segments.slice(0, -1), child]))?.displayName ?? child;
        const clash = this.autoChildren(parentKey).find((c) => c.toLowerCase() !== original.toLowerCase() && shown(c).toLowerCase() === n.name.toLowerCase());
        if (clash) throw new Error(`A folder called "${n.name}" already exists here. Pick another name.`);
        this.snapMeta(f.id, snaps, created);
        // naming it back to the automation's own word removes the override
        this.store.setFolderMeta(f.id, { displayName: n.name.toLowerCase() === original.toLowerCase() && n.name === original ? null : n.name });
        touched.folders = true;
        return `Renamed the folder "${original}" to "${n.name}". Its products and subfolders stay where they are.`;
      }
      case "deleteAutoFolder": {
        const f = this.autoFolderOrThrow(o.key);
        const mode = o.mode ?? "move_contents_up";
        const members = this.autoMembers(o.key);
        const depth = f.segments.length; // the removed segment is at index depth-1
        for (const m of members) {
          this.snap("products", m.id, ["category", "family", "placement_locked", "deleted_at", "updated_at"], snaps);
          touched.productIds.add(m.id);
        }
        const label = this.store.getFolderMeta(f.id)?.displayName ?? f.segments[depth - 1];
        if (mode === "trash_with_contents") {
          for (const m of members) this.db.prepare("UPDATE products SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, m.id);
          touched.folders = true;
          return `Sent the folder "${label}" and its ${members.length} product${members.length === 1 ? "" : "s"} to the Trash (kept for 30 days).`;
        }
        // contents move up one level: the folder's own name leaves every path that passed through it. The person placed them, so research does not move them back.
        for (const m of members) {
          const have = splitPath(m.family ?? "");
          const next = [...have.slice(0, depth - 1), ...have.slice(depth)];
          this.db.prepare("UPDATE products SET family = ?, placement_locked = 1, updated_at = ? WHERE id = ?").run(next.length ? next.join(" > ") : null, now, m.id);
        }
        touched.folders = true;
        const where = depth > 1 ? `"${f.segments[depth - 2]}"` : `"${f.category}"`;
        return `Removed the folder "${label}"; its ${members.length} product${members.length === 1 ? "" : "s"} moved up into ${where}.`;
      }
      case "setFolderThumbnail": {
        const f = this.autoFolderOrThrow(o.key);
        let data: string;
        let source: ThumbSource;
        let meta: Record<string, unknown>;
        if (o.imageId) {
          const img = this.image(o.imageId);
          if (!img.imageData) throw new Error("That photo has no picture to use.");
          data = img.imageData;
          source = "user_selected";
          meta = { productId: img.productId, imageId: img.id };
        } else if (o.imageData) {
          data = o.imageData;
          source = "user_upload";
          meta = { fileName: String(o.fileName ?? "").slice(0, 80) || undefined };
        } else throw new Error("Choose a picture first.");
        const ok = checkFolderImage(data);
        if (!ok.ok) throw new Error(ok.error);
        this.snapMeta(f.id, snaps, created);
        this.store.setFolderMeta(f.id, { thumbData: data, thumbSource: source, thumbMeta: { ...meta, chosenAt: now }, thumbLocked: true });
        touched.folders = true;
        return `Set the picture of "${f.segments[f.segments.length - 1]}". Clynx will not replace it.`;
      }
      case "restoreFolderThumbnail": {
        const f = this.autoFolderOrThrow(o.key);
        const cur = this.store.getFolderMeta(f.id);
        if (!cur?.thumbData) throw new Error("That folder has no chosen picture to remove.");
        this.snapMeta(f.id, snaps, created);
        this.store.setFolderMeta(f.id, { thumbData: null, thumbSource: null, thumbMeta: null, thumbLocked: false });
        touched.folders = true;
        return `Went back to automatic pictures for "${f.segments[f.segments.length - 1]}".`;
      }
      case "recordFolderThumbnail": {
        const f = this.autoFolderOrThrow(o.key);
        const cur = this.store.getFolderMeta(f.id);
        // automation never replaces what a person chose; only a person's own request (byRequest) can replace anything
        if (cur?.thumbLocked && isUserThumb(cur.thumbSource) && !o.byRequest) throw new Error("The picture was chosen by the person and is not replaced automatically.");
        if (cur?.thumbLocked && !o.byRequest) throw new Error("The picture was requested by the person and is not replaced automatically.");
        if (o.source !== "placeholder") {
          const ok = checkFolderImage(o.imageData);
          if (!ok.ok) throw new Error(ok.error);
        }
        this.snapMeta(f.id, snaps, created);
        this.store.setFolderMeta(f.id, { thumbData: o.source === "placeholder" ? null : o.imageData, thumbSource: o.source, thumbMeta: { ...(o.meta ?? {}), decorative: o.source === "ai_generated", recordedAt: now }, thumbLocked: !!o.byRequest });
        touched.folders = true;
        return o.source === "ai_generated" ? `Made a new generated picture for "${f.segments[f.segments.length - 1]}".` : `Set an automatic picture for "${f.segments[f.segments.length - 1]}".`;
      }
      case "restoreFolder": {
        const f = this.db.prepare("SELECT id, name, parent_id, name_key FROM library_folders WHERE id = ? AND deleted_at IS NOT NULL").get(o.id) as { id: string; name: string; parent_id: string | null; name_key: string } | undefined;
        if (!f) throw new Error("That folder is not in the Trash.");
        this.assertSiblingFree(f.parent_id, f.name_key, f.id);
        this.snap("library_folders", f.id, ["deleted_at", "updated_at"], snaps);
        this.db.prepare("UPDATE library_folders SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, f.id);
        touched.folders = true;
        return `Restored the folder "${f.name}".`;
      }
      case "moveProduct":
      case "moveProducts": {
        const ids = o.op === "moveProduct" ? [o.productId] : o.productIds;
        if (o.folderId) this.folder(o.folderId);
        for (const id of ids) {
          const p = this.product(id);
          if (p.deleted_at) throw new Error(`"${p.name}" is in the Trash.`);
          this.snap("products", id, ["folder_id"], snaps);
          this.db.prepare("UPDATE products SET folder_id = ? WHERE id = ?").run(o.folderId, id);
          touched.productIds.add(id);
        }
        return o.folderId ? `Moved ${ids.length} product${ids.length === 1 ? "" : "s"} into "${this.folder(o.folderId).name}".` : `Moved ${ids.length} product${ids.length === 1 ? "" : "s"} back to where Clynx files them.`;
      }
      case "renameProduct": {
        const p = this.product(o.id);
        const n = cleanName(o.name);
        if (!n.ok) throw new Error(n.error);
        const clash = this.db.prepare("SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL AND id != ?").get(n.name, o.id) as { id: string } | undefined;
        if (clash) throw new Error(`Another product is already called "${n.name}".`);
        this.snap("products", o.id, ["name", "name_locked", "updated_at"], snaps);
        this.db.prepare("UPDATE products SET name = ?, name_locked = 1, updated_at = ? WHERE id = ?").run(n.name, now, o.id);
        touched.productIds.add(o.id);
        return `Renamed "${p.name}" to "${n.name}".`;
      }
      case "setProductCategory": {
        const p = this.product(o.id);
        const cat = String(o.category ?? "").trim().slice(0, 60);
        if (!cat) throw new Error("A category is needed.");
        this.snap("products", o.id, ["category", "updated_at"], snaps);
        this.db.prepare("UPDATE products SET category = ?, updated_at = ? WHERE id = ?").run(cat, now, o.id);
        touched.productIds.add(o.id);
        return `Moved "${p.name}" to the ${cat} category.`;
      }
      case "trashProduct": {
        const p = this.product(o.id);
        if (p.deleted_at) throw new Error(`"${p.name}" is already in the Trash.`);
        this.snap("products", o.id, ["deleted_at", "updated_at"], snaps);
        this.db.prepare("UPDATE products SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, o.id);
        touched.productIds.add(o.id);
        return `Sent "${p.name}" to the Trash (kept for 30 days).`;
      }
      case "restoreProduct": {
        const p = this.product(o.id);
        if (!p.deleted_at) throw new Error(`"${p.name}" is not in the Trash.`);
        this.snap("products", o.id, ["deleted_at", "updated_at"], snaps);
        this.db.prepare("UPDATE products SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, o.id);
        touched.productIds.add(o.id);
        return `Restored "${p.name}".`;
      }
      case "removeImage": {
        const i = this.image(o.imageId);
        this.snap("product_images", i.id, ["deleted_at", "is_primary"], snaps);
        this.snap("products", i.productId, ["image_url", "keep_thumbnail", "thumbnail_image_id", "updated_at"], snaps);
        this.db.prepare("UPDATE product_images SET deleted_at = ?, is_primary = 0 WHERE id = ?").run(now, i.id);
        // the thumbnail is a copy; if it came from this photo, clear the pointer (the copy stays until the person chooses another)
        this.db.prepare("UPDATE products SET thumbnail_image_id = NULL, updated_at = ? WHERE id = ? AND thumbnail_image_id = ?").run(now, i.productId, i.id);
        touched.productIds.add(i.productId);
        return "Moved the photo to the Trash.";
      }
      case "restoreImage": {
        const row = this.db.prepare("SELECT id, product_id FROM product_images WHERE id = ? AND deleted_at IS NOT NULL").get(o.imageId) as { id: string; product_id: string } | undefined;
        if (!row) throw new Error("That photo is not in the Trash.");
        this.snap("product_images", row.id, ["deleted_at"], snaps);
        this.db.prepare("UPDATE product_images SET deleted_at = NULL WHERE id = ?").run(row.id);
        touched.productIds.add(row.product_id);
        return "Restored the photo.";
      }
      case "replaceImage": {
        const old = this.image(o.imageId);
        if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(o.imageData) || o.imageData.length > 11_500_000) throw new Error("That is not a usable image (png, jpeg, webp or gif, up to 8 MB).");
        const full = this.db.prepare("SELECT sort_order, is_primary FROM product_images WHERE id = ?").get(old.id) as { sort_order: number; is_primary: number };
        this.snap("product_images", old.id, ["deleted_at", "is_primary"], snaps);
        const id = randomUUID();
        this.db
          .prepare("INSERT INTO product_images (id, product_id, image_data, source_title, created_at, kind, status, source_kind, sort_order, is_primary, origin_product_id) VALUES (?, ?, ?, NULL, ?, ?, 'user', 'user', ?, ?, ?)")
          .run(id, old.productId, o.imageData, now, old.kind, full.sort_order, full.is_primary, old.productId);
        created.push({ table: "product_images", id });
        this.db.prepare("UPDATE product_images SET deleted_at = ?, is_primary = 0 WHERE id = ?").run(now, old.id);
        touched.productIds.add(old.productId);
        return "Replaced the photo (the old one is in the Trash).";
      }
      case "reorderImages": {
        const product = this.product(o.productId);
        const live = (this.db.prepare("SELECT id FROM product_images WHERE product_id = ? AND deleted_at IS NULL").all(o.productId) as Array<{ id: string }>).map((r) => r.id);
        if (o.orderedIds.some((id) => !live.includes(id))) throw new Error("One of those photos is not in this product.");
        const order = [...o.orderedIds, ...live.filter((id) => !o.orderedIds.includes(id))];
        order.forEach((id, index) => {
          this.snap("product_images", id, ["sort_order"], snaps);
          this.db.prepare("UPDATE product_images SET sort_order = ? WHERE id = ?").run(index, id);
        });
        touched.productIds.add(product.id);
        return "Reordered the photos.";
      }
      case "setPrimaryImage": {
        const i = this.image(o.imageId);
        if (i.productId !== o.productId) throw new Error("That photo is not in this product.");
        for (const row of this.db.prepare("SELECT id FROM product_images WHERE product_id = ? AND deleted_at IS NULL").all(o.productId) as Array<{ id: string }>) this.snap("product_images", row.id, ["is_primary"], snaps);
        this.db.prepare("UPDATE product_images SET is_primary = 0 WHERE product_id = ?").run(o.productId);
        this.db.prepare("UPDATE product_images SET is_primary = 1 WHERE id = ?").run(i.id);
        touched.productIds.add(o.productId);
        return "Made that the first photo.";
      }
      case "setThumbnail": {
        const p = this.product(o.productId);
        this.snap("products", o.productId, ["image_url", "keep_thumbnail", "thumbnail_image_id", "updated_at"], snaps);
        if (o.imageId === null) {
          this.db.prepare("UPDATE products SET image_url = NULL, keep_thumbnail = 0, thumbnail_image_id = NULL, updated_at = ? WHERE id = ?").run(now, o.productId);
          touched.productIds.add(o.productId);
          return `Cleared the thumbnail of "${p.name}"; Clynx will pick a new one.`;
        }
        const i = this.image(o.imageId);
        if (i.productId !== o.productId) throw new Error("That photo is not in this product.");
        this.db.prepare("UPDATE products SET image_url = ?, keep_thumbnail = 1, thumbnail_image_id = ?, updated_at = ? WHERE id = ?").run(i.imageData, i.id, now, o.productId);
        touched.productIds.add(o.productId);
        return `Set the thumbnail of "${p.name}".`;
      }
      case "reassignImage": {
        const i = this.image(o.imageId);
        const to = this.product(o.toProductId);
        if (to.deleted_at) throw new Error(`"${to.name}" is in the Trash.`);
        if (i.productId === to.id) throw new Error("It is already there.");
        this.snap("product_images", i.id, ["product_id", "status", "origin_product_id", "is_primary", "sort_order", "verdict_json"], snaps);
        this.db.prepare("UPDATE product_images SET product_id = ?, status = 'user', origin_product_id = ?, is_primary = 0, verdict_json = ? WHERE id = ?").run(to.id, i.productId, JSON.stringify({ outcome: "user", reasons: ["you moved it here"], proposer: "user-move" }), i.id);
        this.snap("products", i.productId, ["thumbnail_image_id", "updated_at"], snaps);
        this.db.prepare("UPDATE products SET thumbnail_image_id = NULL, updated_at = ? WHERE id = ? AND thumbnail_image_id = ?").run(now, i.productId, i.id);
        this.resolveOpenReview(i.id, "accepted", snaps, touched);
        touched.productIds.add(i.productId);
        touched.productIds.add(to.id);
        return `Moved the photo to "${to.name}".`;
      }
      case "newEntryFromImage": {
        const i = this.image(o.imageId);
        const from = this.db.prepare("SELECT category, family FROM products WHERE id = ?").get(i.productId) as { category: string; family: string | null };
        const n = cleanName(o.name);
        if (!n.ok) throw new Error(n.error);
        const clash = this.db.prepare("SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL").get(n.name) as { id: string } | undefined;
        if (clash) throw new Error(`"${n.name}" already exists. Move the photo to it instead.`);
        const sameModel = this.store.existingProductIdForName(n.name);
        if (sameModel) throw new Error(`"${n.name}" is another name for "${(this.db.prepare("SELECT name FROM products WHERE id = ?").get(sameModel) as { name: string }).name}", which already exists. Move the photo to it instead.`);
        const id = randomUUID();
        this.db.prepare("INSERT INTO products (id, name, category, family, loading, created_at, updated_at, name_locked) VALUES (?, ?, ?, ?, 0, ?, ?, 1)").run(id, n.name, from.category, from.family, now, now);
        created.push({ table: "products", id });
        this.snap("product_images", i.id, ["product_id", "status", "origin_product_id", "is_primary", "verdict_json"], snaps);
        this.db.prepare("UPDATE product_images SET product_id = ?, status = 'user', origin_product_id = ?, is_primary = 1, verdict_json = ? WHERE id = ?").run(id, i.productId, JSON.stringify({ outcome: "user", reasons: ["you made a new entry from it"], proposer: "user-new-entry" }), i.id);
        this.resolveOpenReview(i.id, "accepted", snaps, touched);
        touched.productIds.add(i.productId);
        touched.productIds.add(id);
        return `Made a new entry "${n.name}" with this photo.`;
      }
      case "keepImage": {
        const i = this.image(o.imageId);
        this.snap("product_images", i.id, ["status"], snaps);
        this.db.prepare("UPDATE product_images SET status = 'user' WHERE id = ?").run(i.id);
        this.resolveOpenReview(i.id, "rejected", snaps, touched);
        touched.productIds.add(i.productId);
        return "Kept the photo where it is (you vouched for it).";
      }
      case "quarantineImage": {
        const i = this.image(o.imageId);
        this.snap("product_images", i.id, ["status"], snaps);
        this.db.prepare("UPDATE product_images SET status = 'quarantined' WHERE id = ?").run(i.id);
        touched.productIds.add(i.productId);
        return "Set the photo aside (it is no longer used as a reference).";
      }
      case "resolveReview": {
        const item = this.db.prepare("SELECT id, state FROM review_items WHERE id = ?").get(o.itemId) as { id: string; state: string } | undefined;
        if (!item || item.state !== "open") throw new Error("That review item is already settled.");
        this.db.prepare("UPDATE review_items SET state = ?, resolved_at = ?, resolved_by = 'user' WHERE id = ?").run(o.state, now, o.itemId);
        touched.review = true;
        return o.state === "snoozed" ? "Left it for later." : "Marked it as handled.";
      }
      default:
        throw new Error("Unknown operation.");
    }
  }

  private resolveOpenReview(subjectId: string, state: "accepted" | "rejected", _snaps: Snap[], touched: { review: boolean }): void {
    const res = this.db.prepare("UPDATE review_items SET state = ?, resolved_at = ?, resolved_by = 'user' WHERE kind = 'image' AND subject_id = ? AND state = 'open'").run(state, Date.now(), subjectId);
    if (Number(res.changes) > 0) touched.review = true;
  }

  // ---- undo: restores exactly the columns the operation changed, and removes rows it created
  private undo(opId: string, ctx: OpContext): OpResult {
    const row = this.db.prepare("SELECT op, inverse_json, undone_at FROM library_ops WHERE id = ?").get(opId) as { op: string; inverse_json: string | null; undone_at: number | null } | undefined;
    if (!row) return { ok: false, summary: "", error: "I can't find that action." };
    if (row.undone_at) return { ok: false, summary: "", error: "That action was already undone." };
    if (!row.inverse_json) return { ok: false, summary: "", error: "That action can't be undone." };
    const inv = JSON.parse(row.inverse_json) as { snaps: Snap[]; created: Created[] };
    const productIds = new Set<string>();
    try {
      this.store.transaction(() => {
        for (const s of inv.snaps) {
          const cols = Object.keys(s.before);
          if (!cols.length) continue;
          this.db.prepare(`UPDATE ${s.table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => (s.before[c] ?? null) as never), s.id);
          if (s.table === "products") productIds.add(s.id);
          if (s.table === "product_images") {
            const r = this.db.prepare("SELECT product_id FROM product_images WHERE id = ?").get(s.id) as { product_id: string } | undefined;
            if (r) productIds.add(r.product_id);
          }
        }
        for (const c of inv.created) {
          if (c.table === "products") {
            this.db.prepare("DELETE FROM products WHERE id = ?").run(c.id);
            productIds.add(c.id);
          } else if (c.table === "product_images") {
            const r = this.db.prepare("SELECT product_id FROM product_images WHERE id = ?").get(c.id) as { product_id: string } | undefined;
            if (r) productIds.add(r.product_id);
            this.db.prepare("DELETE FROM product_images WHERE id = ?").run(c.id);
          } else if (c.table === "folder_meta") {
            this.db.prepare("DELETE FROM folder_meta WHERE id = ?").run(c.id);
          } else {
            this.db.prepare("UPDATE products SET folder_id = NULL WHERE folder_id = ?").run(c.id);
            this.db.prepare("DELETE FROM library_folders WHERE id = ?").run(c.id);
          }
        }
        this.db.prepare("UPDATE library_ops SET undone_at = ? WHERE id = ?").run(Date.now(), opId);
      });
    } catch (err) {
      return { ok: false, summary: "", error: `Couldn't undo that: ${(err as Error).message}` };
    }
    this.store.invalidateFolders();
    this.onChanged({ productIds: [...productIds], folders: true, review: true });
    return { ok: true, summary: `Undid: ${row.op}.`, opId };
  }

  /** A change Clynx made on its own that the person should be able to see in Recent changes (for example "your price was replaced by real sales"). Not undoable from History. */
  logChange(summary: string): void {
    this.db.prepare("INSERT INTO library_ops (id, at, actor, op, args_json, inverse_json) VALUES (?, ?, 'clynx', 'priceReplaced', ?, NULL)").run(randomUUID(), Date.now(), JSON.stringify({ summary }));
  }

  /** The most recent operations (for a History view and "undo that"). */
  recent(limit = 20): Array<{ id: string; at: number; actor: string; op: string; undone: boolean }> {
    return (this.db.prepare("SELECT id, at, actor, op, undone_at FROM library_ops WHERE actor != 'system' ORDER BY at DESC LIMIT ?").all(limit) as any[]).map((r) => ({ id: r.id, at: r.at, actor: r.actor, op: r.op, undone: !!r.undone_at }));
  }
}

/** What the chat's library_op tool arguments mean as an operation (the chat and the screen then run the very same backend). */
export function toLibraryOp(args: Record<string, unknown>): LibraryOp | { error: string } {
  const text = (k: string) => String(args[k] ?? "").trim();
  const orNull = (k: string) => text(k) || null;
  const need = (...keys: string[]) => keys.find((k) => !text(k));
  switch (text("op")) {
    case "createFolder": return need("name") ? { error: "createFolder needs a name." } : { op: "createFolder", parentId: orNull("parentId"), name: text("name") };
    case "renameFolder": return need("id", "name") ? { error: "renameFolder needs the folder id and a name." } : { op: "renameFolder", id: text("id"), name: text("name") };
    case "moveFolder": return need("id") ? { error: "moveFolder needs the folder id." } : { op: "moveFolder", id: text("id"), newParentId: orNull("parentId") };
    case "deleteFolder": return need("id") ? { error: "deleteFolder needs the folder id." } : { op: "deleteFolder", id: text("id"), mode: args.deleteContents === true ? "trash_with_contents" : "move_contents_up" };
    case "moveProduct": return need("productId") ? { error: "moveProduct needs the product id." } : { op: "moveProduct", productId: text("productId"), folderId: orNull("folderId") };
    case "renameProduct": return need("id", "name") ? { error: "renameProduct needs the product id and a name." } : { op: "renameProduct", id: text("id"), name: text("name") };
    case "trashProduct": return need("id") ? { error: "trashProduct needs the product id." } : { op: "trashProduct", id: text("id") };
    case "restoreProduct": return need("id") ? { error: "restoreProduct needs the product id." } : { op: "restoreProduct", id: text("id") };
    case "removeImage": return need("imageId") ? { error: "removeImage needs the photo id." } : { op: "removeImage", imageId: text("imageId") };
    case "restoreImage": return need("imageId") ? { error: "restoreImage needs the photo id." } : { op: "restoreImage", imageId: text("imageId") };
    case "setPrimaryImage": return need("productId", "imageId") ? { error: "setPrimaryImage needs the product id and the photo id." } : { op: "setPrimaryImage", productId: text("productId"), imageId: text("imageId") };
    case "setThumbnail": return need("productId") ? { error: "setThumbnail needs the product id." } : { op: "setThumbnail", productId: text("productId"), imageId: orNull("imageId") };
    case "reassignImage": return need("imageId", "toProductId") ? { error: "reassignImage needs the photo id and the id of the product it belongs to." } : { op: "reassignImage", imageId: text("imageId"), toProductId: text("toProductId") };
    case "renameAutoFolder": return need("key", "name") ? { error: "renameAutoFolder needs the folder path (key) and the new name." } : { op: "renameAutoFolder", key: text("key"), name: text("name") };
    case "deleteAutoFolder": return need("key") ? { error: "deleteAutoFolder needs the folder path (key)." } : { op: "deleteAutoFolder", key: text("key"), mode: args.deleteContents === true ? "trash_with_contents" : "move_contents_up" };
    case "setFolderThumbnail": return need("key", "imageId") ? { error: "setFolderThumbnail needs the folder path (key) and the id of an existing photo." } : { op: "setFolderThumbnail", key: text("key"), imageId: text("imageId") };
    case "restoreFolderThumbnail": return need("key") ? { error: "restoreFolderThumbnail needs the folder path (key)." } : { op: "restoreFolderThumbnail", key: text("key") };
    case "undo": return need("opId") ? { error: "undo needs the id of the action." } : { op: "undo", opId: text("opId") };
    default: return { error: `Unknown operation "${text("op")}".` };
  }
}
