import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import {
  PROVIDER_LABEL, ago, failureHint, kindLabel, outcomeLabel, outcomeTone, routeLabel, summarizeProvider, verdictTone, formatTokens,
} from "../lib/aiActivityView";
import type { ApiSnapshot, Provider } from "../../../main/apiActivity.js";
import type { SelfTestResult } from "../../../main/apiSelfTest.js";

const TONE: Record<string, string> = { good: "var(--success)", bad: "var(--danger, #ef4444)", warn: "var(--warn)", neutral: "var(--text-muted)" };

type Tab = "decisions" | "requests" | "problems";

// AI Activity: what the paid and market services were asked to do (requests, tokens, estimated cost, failures, and the decisions the AI made, with the picture it looked at and its
// own reasoning). Pull-based like the metrics panel; the numbers are this session's (main/apiActivity.ts keeps a bounded registry, never a key or a token).
export function AiActivityPanel() {
  const [snap, setSnap] = useState<ApiSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>("decisions");
  const [test, setTest] = useState<SelfTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.apiActivity().then((s) => { setSnap(s); setError(null); }).catch((e) => setError(String(e?.message ?? e)));
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const runTest = async () => {
    setTesting(true);
    try { setTest(await api.apiSelfTest()); } catch (e: any) { setError(`The check could not run: ${e?.message ?? e}`); } finally { setTesting(false); refresh(); }
  };

  const summaries = useMemo(() => (snap ? (["openai", "ebay", "watchcount"] as Provider[]).map((p) => summarizeProvider(p, snap.providers[p], snap.now)) : []), [snap]);
  if (!snap) return <div className="card" style={{ padding: 18 }}>{error ? `AI Activity is unavailable: ${error}` : "Loading AI Activity…"}</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: 0, flex: 1, overflowY: "auto", paddingBottom: 24 }}>
      {snap.source && (
        <div className="card" style={{ padding: 14, fontSize: 13.5, lineHeight: 1.5 }}>
          <div><strong>AI goes through:</strong> {snap.source.ai}</div>
          <div><strong>eBay goes through:</strong> {snap.source.ebay}</div>
          <div style={{ color: "var(--text-muted)", marginTop: 4 }}>{snap.source.note} Counts are for this session (since {new Date(snap.startedAt).toLocaleTimeString()}).</div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
        {summaries.map((s) => (
          <div key={s.provider} className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>{PROVIDER_LABEL[s.provider]}</strong>
              <span style={{ fontSize: 12.5, color: s.headline === "Working" ? TONE.good : s.headline.startsWith("Every") ? TONE.bad : TONE.neutral }}>{s.headline}</span>
            </div>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {s.lines.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
            <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--text-dim)" }}>
              Not made: {s.skipped.budget} over an allowance/limit · {s.skipped.unneeded} not needed · {s.skipped.disabled} turned off / no access
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button className="primary" disabled={testing} onClick={runTest} title="One tiny AI request, one 20-result eBay search and a WatchCount reachability check, through the same code the app uses">
            {testing ? "Checking…" : "Run API check"}
          </button>
          <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>A few dozen tokens at most. Failures are shown as they are, never hidden.</span>
        </div>
        {test && (
          <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6 }}>
            <div style={{ color: test.openai.ok ? TONE.good : TONE.bad }}>
              OpenAI: {test.openai.ok ? "worked" : "FAILED"} via {routeLabel(test.openai.route)}
              {test.openai.status ? ` · HTTP ${test.openai.status}` : ""}{test.openai.ms !== null ? ` · ${test.openai.ms} ms` : ""} · model {test.openai.model}
              {test.openai.tokens ? ` · ${formatTokens(test.openai.tokens.input ?? 0)} in / ${formatTokens(test.openai.tokens.output ?? 0)} out` : ""}
              {test.openai.error ? ` · ${test.openai.error}` : ""}
            </div>
            <div style={{ color: test.ebay.ok ? TONE.good : TONE.bad }}>
              eBay: {test.ebay.ok ? "worked" : test.ebay.skipped ? "NOT CHECKED" : "FAILED"}
              {test.ebay.ok ? ` · "${test.ebay.query}": ${test.ebay.retrieved} results, ${test.ebay.accepted} accepted, ${test.ebay.rejected} rejected, ${test.ebay.uncertain} unsure${test.ebay.medianAskUsd !== null ? ` · median ASKING price $${Math.round(test.ebay.medianAskUsd)} (not a sold price)` : ""}` : ` · ${test.ebay.skipped ?? test.ebay.error}`}
            </div>
            <div style={{ color: test.watchcount.ok ? TONE.good : TONE.bad }}>
              WatchCount: {test.watchcount.ok ? "reachable" : "NOT REACHABLE"}{test.watchcount.status ? ` · HTTP ${test.watchcount.status}` : ""}{test.watchcount.error ? ` · ${test.watchcount.error}` : ""} <span style={{ color: "var(--text-dim)" }}>({test.watchcount.note})</span>
            </div>
          </div>
        )}
      </div>

      <div role="group" aria-label="AI Activity view" style={{ display: "flex", gap: 4 }}>
        {([["decisions", `Decisions (${snap.decisions.length})`], ["requests", `Requests (${snap.recent.length})`], ["problems", `Problems (${snap.recentFailures.length})`]] as Array<[Tab, string]>).map(([id, label]) => (
          <button key={id} className="icon ghost" aria-pressed={tab === id} onClick={() => setTab(id)}
            style={{ padding: "4px 12px", fontSize: 13, border: `1px solid ${tab === id ? "var(--accent-1)" : "var(--border)"}`, color: tab === id ? "var(--text)" : "var(--text-muted)" }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "decisions" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {snap.decisions.length === 0 && <div className="card" style={{ padding: 14, color: "var(--text-muted)" }}>No AI decisions yet this session. They appear here as Clynx looks at photos, judges listings and checks comparable sales. If a scan has run and this stays empty, see the numbers above: the calls may be going through Clynx Cloud, being skipped by Save OpenAI credits, or answered from the Database.</div>}
          {snap.decisions.map((d, i) => (
            <div key={`${d.ts}-${i}`} className="card" style={{ padding: 12, display: "flex", gap: 12, alignItems: "flex-start" }}>
              {d.image ? <img src={d.image} alt={`What the AI looked at: ${d.subject}`} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} /> : <div style={{ width: 72, height: 72, borderRadius: 8, background: "var(--bg-card-hover)", flexShrink: 0, display: "grid", placeItems: "center", color: "var(--text-dim)", fontSize: 11 }}>no image</div>}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13.5 }}>{kindLabel(d.kind)}</strong>
                  <span style={{ fontSize: 12.5, color: TONE[verdictTone(d)] }}>{d.verdict}</span>
                  <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{ago(d.ts, snap.now)}{d.model ? ` · ${d.model}` : ""}</span>
                </div>
                <div style={{ fontSize: 13, marginTop: 2, overflowWrap: "anywhere" }}>{d.subject}</div>
                {d.thought && <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.45, overflowWrap: "anywhere" }}>{d.thought}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "requests" && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr style={{ textAlign: "left", color: "var(--text-dim)" }}>{["When", "Service", "What for", "What happened", "Via", "Status", "ms", "Results / tokens"].map((h) => <th key={h} style={{ padding: "8px 10px", fontWeight: 600 }}>{h}</th>)}</tr></thead>
            <tbody>
              {snap.recent.map((e, i) => (
                <tr key={`${e.ts}-${i}`} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>{ago(e.ts, snap.now)}</td>
                  <td style={{ padding: "6px 10px" }}>{PROVIDER_LABEL[e.provider]}</td>
                  <td style={{ padding: "6px 10px" }}>{e.kind}</td>
                  <td style={{ padding: "6px 10px", color: TONE[outcomeTone(e.outcome)] }} title={e.error ?? undefined}>{outcomeLabel(e.outcome)}</td>
                  <td style={{ padding: "6px 10px" }}>{routeLabel(e.route)}</td>
                  <td style={{ padding: "6px 10px" }}>{e.status ?? ""}</td>
                  <td style={{ padding: "6px 10px" }}>{e.ms ?? ""}</td>
                  <td style={{ padding: "6px 10px" }}>{e.results !== null && e.results !== undefined ? `${e.results} results` : e.tokens ? `${formatTokens(e.tokens.total ?? 0)} tokens` : e.tokensNotReported ? "tokens not reported" : ""}</td>
                </tr>
              ))}
              {snap.recent.length === 0 && <tr><td colSpan={8} style={{ padding: 14, color: "var(--text-muted)" }}>No requests or decisions recorded yet this session.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "problems" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {snap.recentFailures.length === 0 && <div className="card" style={{ padding: 14, color: "var(--text-muted)" }}>No failed requests this session.</div>}
          {snap.recentFailures.map((e, i) => {
            const hint = failureHint(e);
            return (
              <div key={`${e.ts}-${i}`} className="card" style={{ padding: 12 }}>
                <div style={{ fontSize: 13 }}><strong>{PROVIDER_LABEL[e.provider]}</strong> · {e.kind} · {ago(e.ts, snap.now)}{e.status ? ` · HTTP ${e.status}` : ""}</div>
                <div style={{ fontSize: 12.5, color: TONE.bad, marginTop: 4, overflowWrap: "anywhere" }}>{e.error}</div>
                {hint && <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>{hint}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
