import React, { useState } from "react";
import { api } from "../lib/api.js";
import { describeTopicStrength, subscribeAddress, topicStrengthMessage } from "../../../main/ntfyTopic.js";

/**
 * Phone alerts (ntfy) setup, shared by Config > Notifications and the first-run checklist: how to connect a phone, a generated private
 * topic, and a Send test notification button. It only edits the values it is given; saving stays with the caller. An existing topic is
 * never replaced without an explicit confirmation (the phone is subscribed to it).
 */
export function NtfySetup({ server, topic, onChange }: { server: string; topic: string; onChange: (next: { server: string; topic: string }) => void }) {
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const strength = describeTopicStrength(topic);
  const warning = topicStrengthMessage(strength);

  async function generate() {
    const fresh = await api.generateNtfyTopic();
    setConfirmReplace(false);
    setResult(null);
    onChange({ server, topic: fresh });
  }

  async function sendTest() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.sendTestNotification(server, topic));
    } catch (err) {
      setResult({ ok: false, message: "The test could not be sent. Try again." });
    } finally {
      setTesting(false);
    }
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(topic.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable: the topic is on screen to copy by hand */
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, lineHeight: 1.6, color: "var(--text-muted)" }}>
        <li>
          Install the free <b>ntfy</b> app on your phone (iPhone: App Store, Android: Google Play).
        </li>
        <li>
          In ntfy tap <b>+</b> (subscribe to topic), type the topic below exactly, and keep the default server{" "}
          <b>{server.replace(/^https?:\/\//, "") || "ntfy.sh"}</b>.
        </li>
        <li>
          Press <b>Send test notification</b> here. It should pop up on your phone within seconds.
        </li>
      </ol>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor="ntfy-server">Server</label>
          <input id="ntfy-server" value={server} onChange={(e) => onChange({ server: e.target.value, topic })} spellCheck={false} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 260 }}>
          <label htmlFor="ntfy-topic">Topic (works like a password: keep it private)</label>
          <input id="ntfy-topic" value={topic} onChange={(e) => onChange({ server, topic: e.target.value })} spellCheck={false} autoComplete="off" aria-describedby="ntfy-topic-help" />
        </div>
      </div>

      <div id="ntfy-topic-help" style={{ fontSize: 13, color: strength === "private" ? "var(--text-dim)" : strength === "empty" ? "var(--text-dim)" : "var(--warn)" }} role={warning && strength !== "empty" ? "alert" : undefined}>
        {strength === "private" ? "This topic is long and random, so nobody can guess it." : warning}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!confirmReplace ? (
          <button
            type="button"
            className="icon"
            onClick={() => (topic.trim() ? setConfirmReplace(true) : generate())}
          >
            {topic.trim() ? "Replace with a new private topic" : "Generate private topic"}
          </button>
        ) : (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            Your phone is subscribed to the current topic and would need the new one.
            <button type="button" className="icon" onClick={generate}>
              Replace it
            </button>
            <button type="button" className="icon ghost" onClick={() => setConfirmReplace(false)}>
              Keep current
            </button>
          </span>
        )}
        <button type="button" className="icon" disabled={!topic.trim()} onClick={copyAddress}>
          {copied ? "Copied" : "Copy topic"}
        </button>
        <button type="button" className="primary" disabled={testing || !topic.trim()} onClick={sendTest}>
          {testing ? "Sending..." : "Send test notification"}
        </button>
        {topic.trim() && strength !== "invalid" && <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>Phone subscribes to: {subscribeAddress(server, topic)}</span>}
      </div>

      <div role="status" aria-live="polite" style={{ minHeight: 18, fontSize: 13.5, color: result ? (result.ok ? "var(--success)" : "var(--danger)") : "var(--text-dim)" }}>
        {result?.message}
      </div>
    </div>
  );
}
