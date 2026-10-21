import { AttentionContext } from "../lib/AttentionContext";
import { attentionLabel } from "../lib/attention";
import React, { useCallback, useContext, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { ProductProfile } from "../lib/api.js";
import type { LibraryOp, OpResult } from "../../../main/libraryOps.js";
import { Modal } from "./Modal.js";
import { imageSource } from "../lib/imageSource.js";

// Beta 13 Library tools: Needs review, Trash and recent changes, folder dialogs, and the "Organize" card on a product page. Everything goes through ONE backend call
// (api.libraryOp -> libraryOps.ts), the same one the chat uses, so a rule is never implemented twice. A consequential operation answers with a question first; asking is
// done here (the person decides) and the answer comes back with the token the backend issued.

export const MY_FOLDERS = "My folders";

export type LibraryFolder = { id: string; parentId: string | null; name: string; position: number; kind: string };

/** "Parent > Child" paths of every folder (for pickers and for showing empty folders in the tree). */
export function folderPaths(folders: LibraryFolder[]): Array<{ id: string; path: string }> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (f: LibraryFolder): string => {
    const parts: string[] = [];
    let cur: LibraryFolder | undefined = f;
    for (let i = 0; cur && i < 12; i++) {
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(" > ");
  };
  return folders.map((f) => ({ id: f.id, path: pathOf(f) })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Runs one Library operation, asking the question the backend wants asked first. Returns the final result (ok:false with `error` when it failed or was declined). */
export async function runLibraryOp(op: LibraryOp): Promise<OpResult> {
  const first = await api.libraryOp(op);
  if (first.needsConfirmation) {
    if (!window.confirm(first.needsConfirmation.prompt)) return { ok: false, summary: "", error: "Cancelled." };
    return api.libraryOp(op, first.needsConfirmation.token);
  }
  return first;
}

const note = (text: string) => window.dispatchEvent(new CustomEvent("clynx:library-note", { detail: text }));

/** A one-line result strip with Undo, shown under the Library toolbar. */
export function LibraryNote() {
  const [msg, setMsg] = useState<{ text: string; opId?: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setMsg(typeof (e as CustomEvent).detail === "string" ? { text: (e as CustomEvent).detail } : (e as CustomEvent).detail);
    window.addEventListener("clynx:library-note", on);
    return () => window.removeEventListener("clynx:library-note", on);
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 12_000);
    return () => clearTimeout(t);
  }, [msg]);
  if (!msg) return null;
  return (
    <div className="card" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", fontSize: 14 }}>
      <span style={{ flex: 1 }}>{msg.text}</span>
      {msg.opId && (
        <button
          className="icon ghost"
          onClick={async () => {
            const r = await api.libraryOp({ op: "undo", opId: msg.opId! });
            setMsg({ text: r.ok ? r.summary : (r.error ?? "Couldn't undo.") });
          }}
        >
          ↶ Undo
        </button>
      )}
      <button className="icon ghost" onClick={() => setMsg(null)}>
        ✕
      </button>
    </div>
  );
}

/** Runs an operation and reports it (with Undo) in the strip above. */
export async function doLibraryOp(op: LibraryOp): Promise<OpResult> {
  const r = await runLibraryOp(op);
  window.dispatchEvent(new CustomEvent("clynx:library-note", { detail: r.ok ? { text: r.summary, opId: r.opId } : { text: r.error ?? "That didn't work." } }));
  return r;
}

export function FolderDialog({
  mode,
  folders,
  folder,
  onClose,
}: {
  mode: "create" | "rename" | "delete";
  folders: LibraryFolder[];
  /** The folder being renamed / deleted, or the parent of a new one (null = top level). */
  folder: LibraryFolder | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(mode === "rename" ? (folder?.name ?? "") : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withContents, setWithContents] = useState(false);
  async function go() {
    setBusy(true);
    setError(null);
    const op: LibraryOp =
      mode === "create" ? { op: "createFolder", parentId: folder?.id ?? null, name } : mode === "rename" ? { op: "renameFolder", id: folder!.id, name } : { op: "deleteFolder", id: folder!.id, mode: withContents ? "trash_with_contents" : "move_contents_up" };
    const r = await doLibraryOp(op);
    setBusy(false);
    if (r.ok) onClose();
    else if (r.error && r.error !== "Cancelled.") setError(r.error);
  }
  return (
    <Modal title={mode === "create" ? (folder ? `New folder in "${folder.name}"` : "New folder") : mode === "rename" ? "Rename folder" : `Delete "${folder?.name}"?`} onClose={onClose}>
      {mode === "delete" ? (
        <>
          <p style={{ margin: 0, fontSize: 14.5, color: "var(--text-muted)", lineHeight: 1.5 }}>The folder goes to the Trash (kept for 30 days). Products inside move up one level unless you choose to send them along.</p>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
            <input type="checkbox" checked={withContents} onChange={(e) => setWithContents(e.target.checked)} /> Also send everything inside to the Trash
          </label>
        </>
      ) : (
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Folder name" onKeyDown={(e) => e.key === "Enter" && name.trim() && go()} />
      )}
      {error && <div style={{ color: "var(--danger)", fontSize: 13.5 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="icon" style={{ flex: 1 }} onClick={onClose}>
          Cancel
        </button>
        <button className={mode === "delete" ? "danger-solid" : "primary"} style={{ flex: 1 }} disabled={busy || (mode !== "delete" && !name.trim())} onClick={go}>
          {mode === "create" ? "Create" : mode === "rename" ? "Rename" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}

type ReviewRow = Awaited<ReturnType<typeof api.libraryReview>>[number];

/** Phase 2.2 / 2.4: the duplicate clean-up. First a read-only report ("N entries would become M"), then a merge of exactly that report, then Undo for 30 days. */
function CleanupSection() {
  const [view, setView] = useState<Awaited<ReturnType<typeof api.libraryCleanupPlan>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const look = async () => {
    setBusy(true);
    setMessage("");
    try {
      setView(await api.libraryCleanupPlan());
    } finally {
      setBusy(false);
    }
  };
  const merge = async () => {
    if (!view) return;
    setBusy(true);
    try {
      const r = await api.libraryCleanupRun(view.plan.fingerprint);
      setMessage(r.ok ? `Merged ${r.merged} entr${r.merged === 1 ? "y" : "ies"}. A backup copy was made first, and you can undo this below.` : (r.error ?? "Nothing was merged."));
      setView(await api.libraryCleanupPlan());
    } finally {
      setBusy(false);
    }
  };
  const undo = async (batchId: string) => {
    setBusy(true);
    try {
      const r = await api.libraryCleanupUndo(batchId);
      setMessage(r.ok ? `Put back ${r.restored} entr${r.restored === 1 ? "y" : "ies"}.` : "Nothing to put back.");
      setView(await api.libraryCleanupPlan());
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 14.5, fontWeight: 600 }}>Same product under different names</div>
      <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>See which entries Clynx is sure are one product. Looking changes nothing.</div>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="icon" disabled={busy} onClick={look}>
          Show me what would merge
        </button>
        {view && view.plan.groups.length > 0 && (
          <button className="primary" disabled={busy} onClick={merge}>
            Merge these {view.plan.groups.length} group{view.plan.groups.length === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {view && <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 13, fontFamily: "inherit" }}>{view.text}</pre>}
      {view?.batches.filter((b) => !b.undone).map((b) => (
        <div key={b.batchId} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5 }}>
          <span style={{ flex: 1 }}>
            {new Date(b.at).toLocaleString()} — folded {b.folded} into {b.keptNames.join(", ")}
          </span>
          <button className="icon" disabled={busy} onClick={() => undo(b.batchId)}>
            Undo
          </button>
        </div>
      ))}
      {message && <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>{message}</div>}
    </div>
  );
}

/** "Needs your price knowledge": the name Clynx thinks it is, then Yes / Similar but different / No. */
function PriceQuestion({ row, onDone }: { row: ReviewRow; onDone: () => void }) {
  const productId = String(row.evidence.productId ?? row.subjectId);
  const [step, setStep] = useState<"ask" | "yes" | "no">("ask");
  const [low, setLow] = useState("");
  const [high, setHigh] = useState("");
  const [condition, setCondition] = useState("");
  const [includes, setIncludes] = useState("");
  const [recency, setRecency] = useState("");
  const [error, setError] = useState("");
  const [howTo, setHowTo] = useState<string[]>([]);
  const dismiss = async (how: "later" | "never" | "notSure") => {
    await api.priceDismiss(productId, how);
    onDone();
  };
  const save = async () => {
    const r = await api.priceAnswer({ productId, lowUsd: Number(low), highUsd: high ? Number(high) : undefined, condition, includes, recency });
    if (!r.ok) return setError(r.error ?? "That did not save.");
    onDone();
  };
  return (
    <>
      <div style={{ fontSize: 14.5 }}>
        <strong>Needs your price knowledge:</strong> I think this is <strong>{row.productName ?? "(gone)"}</strong>. {row.reasons.join(" ")}
      </div>
      {step === "ask" && (
        <>
          <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>Have you seen this before?</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="icon" onClick={() => setStep("yes")}>Yes, that's it</button>
            <button className="icon" onClick={() => { void api.priceDismiss(productId, "later"); void api.libraryOp({ op: "resolveReview", itemId: row.id, state: "snoozed" }).then(onDone); }} title="Pick the right model or version in the entry's page, then answer again">Similar but different</button>
            <button className="icon" onClick={() => { setStep("no"); void api.priceHowTo().then(setHowTo); }}>No / not sure</button>
            <button className="icon ghost" onClick={() => dismiss("later")}>Ask me later</button>
            <button className="icon ghost" onClick={() => dismiss("never")}>Don't ask for this product</button>
          </div>
        </>
      )}
      {step === "yes" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>What does it usually sell for? One number, or a range. What a buyer pays in total is best.</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input inputMode="decimal" placeholder="Low $" value={low} onChange={(e) => setLow(e.target.value)} style={{ width: 110 }} />
            <input inputMode="decimal" placeholder="High $ (optional)" value={high} onChange={(e) => setHigh(e.target.value)} style={{ width: 150 }} />
          </div>
          <input placeholder="Condition (used - good, new in box...)" value={condition} onChange={(e) => setCondition(e.target.value)} />
          <input placeholder="What is included (controller, box...)" value={includes} onChange={(e) => setIncludes(e.target.value)} />
          <input placeholder="How recent (this week, last month...)" value={recency} onChange={(e) => setRecency(e.target.value)} />
          {error && <div style={{ color: "var(--danger)", fontSize: 13.5 }}>{error}</div>}
          <div style={{ display: "flex", gap: 6 }}>
            <button className="primary" onClick={save}>Save my price</button>
            <button className="icon ghost" onClick={() => setStep("ask")}>Back</button>
          </div>
        </div>
      )}
      {step === "no" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13.5 }}>
          <div>No problem. Here is how to check what it really sells for:</div>
          <ol style={{ margin: 0, paddingLeft: 20 }}>{howTo.map((h) => <li key={h}>{h}</li>)}</ol>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="icon" onClick={() => void api.priceOpenSold(productId)}>Open eBay's sold listings in my browser</button>
            <button className="icon" onClick={() => setStep("yes")}>I found it: enter my price</button>
            <button className="icon ghost" onClick={() => dismiss("later")}>Ask me later</button>
          </div>
        </div>
      )}
    </>
  );
}

/** Phase 4: the owner's own sold prices - paste a list, or load a Terapeak / Seller Hub export. They join every later sold-price search and go through the same identity checks. */
function SoldImportSection() {
  const [text, setText] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.soldImportStatus().then((r) => setTotal(r.total)).catch(() => undefined);
  }, []);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.soldImport(text);
      setTotal(r.total);
      setMessage(`Added ${r.added} sale${r.added === 1 ? "" : "s"}.${r.skipped.length ? ` Skipped ${r.skipped.length} line${r.skipped.length === 1 ? "" : "s"}: ${r.skipped.slice(0, 3).map((x) => `line ${x.line} (${x.reason})`).join("; ")}.` : ""}`);
      if (r.added > 0) setText("");
    } finally {
      setBusy(false);
    }
  };
  const pick = (file: File | undefined) => {
    if (!file) return;
    void file.text().then(setText);
  };
  return (
    <details className="card" style={{ padding: 12 }}>
      <summary style={{ fontSize: 14.5, fontWeight: 600, cursor: "pointer" }}>Import sold prices{total ? ` (${total} kept)` : ""}</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>
          Paste lines like “Xbox Series X Galaxy Black 2TB $1,099.00”, or a CSV with a title and a price column (Terapeak and Seller Hub exports work). These are used as sold prices for matching products, after the same checks as everything else.
        </div>
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste sold prices here" aria-label="Sold prices to import" />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <label className="icon" style={{ cursor: "pointer" }}>
            Load a file…
            <input type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }} onChange={(e) => pick(e.target.files?.[0])} />
          </label>
          <button className="primary" disabled={busy || !text.trim()} onClick={run}>Import</button>
          {total ? <button className="icon ghost" disabled={busy} onClick={() => void api.soldImportClear().then(() => { setTotal(0); setMessage("Removed your imported sales."); })}>Remove all my imports</button> : null}
        </div>
        {message && <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>{message}</div>}
      </div>
    </details>
  );
}

export function NeedsReviewPanel({ products, onClose }: { products: ProductProfile[]; onClose: () => void }) {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const unseen = useContext(AttentionContext);
  const isUnseen = (id: string) => unseen.items.some((i) => i.id === id);
  // opening an item (a click or a focus inside it) is what clears ITS dot; nothing else does
  const open = (id: string) => {
    if (isUnseen(id)) void api.attentionAck(id);
  };
  const load = useCallback(() => {
    api.libraryReview().then(setRows);
  }, []);
  useEffect(() => {
    load();
    const off = api.onLibraryChanged(() => load());
    return () => {
      off();
    };
  }, [load]);
  const act = async (op: LibraryOp) => {
    await doLibraryOp(op);
    load();
  };
  return (
    <Modal title={`🔎 Needs review${rows ? ` (${rows.length})` : ""}`} onClose={onClose} width={760}>
      <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Clynx sets a photo aside when its own title or the photos around it disagree, and it never moves or deletes anything by a picture-only guess. You decide here; every choice can be undone.
      </p>
      {unseen.count > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "var(--text-muted)" }}>
          <span style={{ flex: 1 }}>{attentionLabel(unseen.count)}.</span>
          <button className="icon ghost" onClick={() => void api.attentionAckAll()}>
            Mark all as seen
          </button>
        </div>
      )}
      <CleanupSection />
      <SoldImportSection />
      {rows === null && <div style={{ color: "var(--text-dim)" }}>Loading…</div>}
      {rows?.length === 0 && <div style={{ color: "var(--text-dim)" }}>Nothing needs your attention.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: "60vh", overflowY: "auto" }}>
        {rows?.map((r) => (
          <div key={r.id} className="card" style={{ display: "flex", gap: 12, padding: 12, position: "relative" }} onClick={() => open(r.id)} onFocus={() => open(r.id)}>
            {isUnseen(r.id) && <span className="nav-item-pulse-dot attention-dot steady" role="img" aria-label="New: you have not opened this yet" />}
            {r.kind === "image" && r.image && <img src={r.image} alt="" style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              {r.kind === "image" && (
                <>
                  <div style={{ fontSize: 14.5 }}>
                    Filed under <strong>{r.productName ?? "(gone)"}</strong>
                    {typeof r.evidence.sourceTitle === "string" && r.evidence.sourceTitle ? (
                      <span style={{ color: "var(--text-dim)" }}>
                        {" "}
                        — source: {imageSource(r.evidence.sourceTitle as string).name}
                        {imageSource(r.evidence.sourceTitle as string).detail ? ` (${imageSource(r.evidence.sourceTitle as string).detail})` : ""}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 13.5, color: "var(--warn)" }}>{r.reasons.join(" · ")}</div>
                  {r.suggestedName && <div style={{ fontSize: 13.5, color: "var(--text-muted)" }}>A picture check suggests: {r.suggestedName}</div>}
                  <MoveTo products={products} excludeId={String(r.evidence.productId ?? "")} onPick={(id) => act({ op: "reassignImage", imageId: r.subjectId, toProductId: id })} suggestedId={typeof r.evidence.suggestedProductId === "string" ? (r.evidence.suggestedProductId as string) : null} />
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button className="icon" onClick={() => act({ op: "keepImage", imageId: r.subjectId })}>
                      It belongs here
                    </button>
                    <button
                      className="icon"
                      onClick={() => {
                        const name = window.prompt("Name for the new entry:", typeof r.evidence.suggestedSubject === "string" ? (r.evidence.suggestedSubject as string) : "");
                        if (name?.trim()) void act({ op: "newEntryFromImage", imageId: r.subjectId, name });
                      }}
                    >
                      Make a new entry
                    </button>
                    <button className="icon ghost" onClick={() => act({ op: "removeImage", imageId: r.subjectId })}>
                      Move to Trash
                    </button>
                    <button className="icon ghost" onClick={() => act({ op: "resolveReview", itemId: r.id, state: "snoozed" })}>
                      Later
                    </button>
                  </div>
                </>
              )}
              {r.kind === "price" && <PriceQuestion row={r} onDone={load} />}
              {r.kind === "merge" && (
                <>
                  <div style={{ fontSize: 14.5 }}>{r.reasons.join(" ")}</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="icon" onClick={() => act({ op: "mergeProducts", ids: (r.evidence.ids as string[]) ?? [] }).then(() => api.libraryOp({ op: "resolveReview", itemId: r.id, state: "accepted" }).then(load))}>
                      Merge them
                    </button>
                    <button className="icon ghost" onClick={() => act({ op: "resolveReview", itemId: r.id, state: "rejected" })}>
                      They are different
                    </button>
                  </div>
                </>
              )}
              {r.kind === "product" && (
                <>
                  <div style={{ fontSize: 14.5 }}>
                    Clynx would have added <strong>{String(r.evidence.proposedName ?? "")}</strong> from the listing “{String(r.evidence.title ?? "")}”
                  </div>
                  <div style={{ fontSize: 13.5, color: "var(--warn)" }}>{r.reasons.join(" · ")}</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="icon ghost" onClick={() => act({ op: "resolveReview", itemId: r.id, state: "rejected" })}>
                      Leave it out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function MoveTo({ products, excludeId, onPick, suggestedId }: { products: ProductProfile[]; excludeId: string; onPick: (id: string) => void; suggestedId: string | null }) {
  const [id, setId] = useState(suggestedId ?? "");
  const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <select value={id} onChange={(e) => setId(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
        <option value="">Move to…</option>
        {sorted.filter((p) => p.id !== excludeId).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button className="icon" disabled={!id} onClick={() => onPick(id)}>
        Move
      </button>
    </div>
  );
}

export function TrashPanel({ onClose }: { onClose: () => void }) {
  const [trash, setTrash] = useState<Awaited<ReturnType<typeof api.libraryTrash>> | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.libraryHistory>>>([]);
  const load = useCallback(() => {
    api.libraryTrash().then(setTrash);
    api.libraryHistory().then(setHistory);
  }, []);
  useEffect(() => {
    load();
    const off = api.onLibraryChanged(() => load());
    return () => {
      off();
    };
  }, [load]);
  const act = async (op: LibraryOp) => {
    await doLibraryOp(op);
    load();
  };
  const empty = trash && !trash.products.length && !trash.images.length && !trash.folders.length;
  return (
    <Modal title="🗑 Trash and recent changes" onClose={onClose} width={680}>
      <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>Deleted items stay here for 30 days, then go for good.</p>
      {empty && <div style={{ color: "var(--text-dim)" }}>The Trash is empty.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "34vh", overflowY: "auto" }}>
        {trash?.products.map((p) => (
          <Row key={p.id} label={`📦 ${p.name}`} when={p.deletedAt} onRestore={() => act({ op: "restoreProduct", id: p.id })} />
        ))}
        {trash?.folders.map((f) => (
          <Row key={f.id} label={`📁 ${f.name}`} when={f.deletedAt} onRestore={() => act({ op: "restoreFolder", id: f.id })} />
        ))}
        {trash?.images.map((i) => (
          <Row key={i.id} label={`🖼 photo in ${i.productName}${i.sourceTitle ? ` (${imageSource(i.sourceTitle).name})` : ""}`} when={i.deletedAt} onRestore={() => act({ op: "restoreImage", imageId: i.id })} />
        ))}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Recent changes</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: "24vh", overflowY: "auto" }}>
        {history.length === 0 && <div style={{ color: "var(--text-dim)", fontSize: 14 }}>Nothing yet.</div>}
        {history.map((h) => (
          <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
            <span style={{ color: "var(--text-dim)", width: 130 }}>{new Date(h.at).toLocaleString()}</span>
            <span style={{ flex: 1 }}>
              {h.op} <span style={{ color: "var(--text-dim)" }}>({h.actor === "chat" ? "by chat" : h.actor === "system" ? "automatic" : "you"})</span>
              {h.undone ? " — undone" : ""}
            </span>
            {!h.undone && h.op !== "mergeProducts" && h.op !== "undo" && (
              <button className="icon ghost" onClick={() => act({ op: "undo", opId: h.id })}>
                ↶ Undo
              </button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function Row({ label, when, onRestore }: { label: string; when: number; onRestore: () => void }) {
  const days = Math.max(0, 30 - Math.floor((Date.now() - when) / 86_400_000));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ color: "var(--text-dim)", fontSize: 12.5 }}>{days} day{days === 1 ? "" : "s"} left</span>
      <button className="icon" onClick={onRestore}>
        Restore
      </button>
    </div>
  );
}

/** On a product's page: where it lives, its name, and a way to the Trash. Placement changes only where it is shown, never what it is or what it is worth. */
export function OrganizeCard({ product, folders }: { product: ProductProfile; folders: LibraryFolder[] }) {
  const paths = folderPaths(folders);
  const [name, setName] = useState(product.name);
  useEffect(() => setName(product.name), [product.name]);
  const [creating, setCreating] = useState(false);
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Organize</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
          Folder
          <select
            value={product.folderId ?? ""}
            onChange={(e) => {
              if (e.target.value === "__new") setCreating(true);
              else void doLibraryOp({ op: "moveProduct", productId: product.id, folderId: e.target.value || null });
            }}
          >
            <option value="">Where Clynx files it{product.family ? ` (${product.family})` : ""}</option>
            {paths.map((p) => (
              <option key={p.id} value={p.id}>
                {p.path}
              </option>
            ))}
            <option value="__new">+ New folder…</option>
          </select>
        </label>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flex: 1, minWidth: 220 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button className="icon" disabled={!name.trim() || name.trim() === product.name} onClick={() => doLibraryOp({ op: "renameProduct", id: product.id, name })}>
            Rename
          </button>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>Moving or renaming never changes what this product is, its photos or its prices.{product.nameLocked ? " You named this one." : ""}</div>
      {creating && <FolderDialog mode="create" folders={folders} folder={null} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Small per-photo actions in the gallery: first photo, thumbnail, move to another product, status badge. */
export function PhotoActions({ image, productId, products, onChanged }: { image: { id: string; status: string }; productId: string; products: ProductProfile[]; onChanged: () => void }) {
  const [moving, setMoving] = useState(false);
  const go = async (op: LibraryOp) => {
    await doLibraryOp(op);
    onChanged();
  };
  return (
    <>
      <div style={{ display: "flex", gap: 2, justifyContent: "center", marginTop: 2 }}>
        <button className="icon ghost" title="Make this the first photo" style={{ padding: "0 4px", fontSize: 12 }} onClick={() => go({ op: "setPrimaryImage", productId, imageId: image.id })}>
          ★
        </button>
        <button className="icon ghost" title="Use as the thumbnail" style={{ padding: "0 4px", fontSize: 12 }} onClick={() => go({ op: "setThumbnail", productId, imageId: image.id })}>
          🖼
        </button>
        <button className="icon ghost" title="Wrong product? Move it" style={{ padding: "0 4px", fontSize: 12 }} onClick={() => setMoving(true)}>
          ↔
        </button>
      </div>
      {moving && (
        <Modal title="Move this photo to another product" onClose={() => setMoving(false)}>
          <MoveTo
            products={products}
            excludeId={productId}
            suggestedId={null}
            onPick={async (id) => {
              setMoving(false);
              await go({ op: "reassignImage", imageId: image.id, toProductId: id });
            }}
          />
        </Modal>
      )}
    </>
  );
}

export function statusBadge(status: string): { label: string; color: string } | null {
  if (status === "trusted" || status === "user" || status === "legacy") return null;
  if (status === "unverified") return { label: "Unverified", color: "var(--warn)" };
  return { label: "Needs review", color: "var(--danger)" };
}

export { note as libraryNote };
