import React, { useEffect, useState } from "react";
import type { ProductProfile } from "../../../main/types.js";
import { api } from "../lib/api.js";

/** Two plain lines on a product page: where the entry came from, and (when it has them) the note that several colour names were folded into it because colour does not move the price. */
export function ProductNotes({ product }: { product: ProductProfile }) {
  const [origin, setOrigin] = useState<{ reason: string; detail: string | null; at: number } | null>(null);
  const [folded, setFolded] = useState<{ colours: string[]; names: string[]; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    api.productOrigin(product.id).then((o) => live && setOrigin(o)).catch(() => undefined);
    api.productFoldedNotice(product.id).then((f) => live && setFolded(f)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [product.id, product.updatedAt]);
  if (!origin && !folded) return null;
  return (
    <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: "var(--text-muted)" }} data-testid="product-notes">
      {folded && (
        <div>
          <strong style={{ color: "var(--text)" }}>Colours share this entry.</strong> {folded.text} Names kept: {folded.names.slice(0, 6).map((n) => `“${n}”`).join(", ")}.
        </div>
      )}
      {origin && origin.reason !== "unspecified" && (
        <div>
          Added: {origin.reason}
          {origin.detail ? ` (${origin.detail.length > 90 ? `${origin.detail.slice(0, 90)}…` : origin.detail})` : ""}, {new Date(origin.at).toLocaleDateString()}.
        </div>
      )}
    </div>
  );
}
