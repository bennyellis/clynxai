import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { emptyAttention, type AttentionSummary } from "./attention";

/** The unopened review items, kept fresh when the Library changes and when the window comes back into focus. */
export function useAttention(): { summary: AttentionSummary; ack: (itemId: string) => void; ackAll: () => void } {
  const [summary, setSummary] = useState<AttentionSummary>(emptyAttention);
  const load = useCallback(() => {
    api.attentionGet().then(setSummary).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const off = api.onLibraryChanged(() => load());
    window.addEventListener("focus", load);
    return () => {
      off();
      window.removeEventListener("focus", load);
    };
  }, [load]);
  const ack = useCallback((itemId: string) => void api.attentionAck(itemId).then(setSummary).catch(() => undefined), []);
  const ackAll = useCallback(() => void api.attentionAckAll().then(setSummary).catch(() => undefined), []);
  return { summary, ack, ackAll };
}
