import type { ChatStatusEvent } from "../../../main/chatSupport.js";

// Beta 13: the live "what is happening" line of a chat turn, built ONLY from real events (a tool started, a tool finished, the model is waiting for its first word). It is
// ephemeral view state: never part of the conversation history and never mixed into the assistant's text. Pure, so it is tested with a fake clock.

export interface StepState {
  id: string;
  label: string;
  kind: ChatStatusEvent["kind"];
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  detail?: string;
}
export type RequestSteps = Record<string, StepState[]>;

export function applyStatusEvent(state: RequestSteps, e: ChatStatusEvent, now: number): RequestSteps {
  const steps = [...(state[e.requestId] ?? [])];
  const i = steps.findIndex((s) => s.id === e.stepId);
  if (e.state === "start") {
    if (i < 0) steps.push({ id: e.stepId, label: e.label, kind: e.kind, startedAt: e.startedAt });
  } else if (i >= 0) {
    steps[i] = e.state === "update" ? { ...steps[i], detail: e.detail ?? steps[i].detail } : { ...steps[i], endedAt: now, ok: e.ok !== false, detail: e.detail ?? steps[i].detail };
  } else if (e.state === "end") {
    // a step that is only ever announced as finished (a notice): show it as done at once
    steps.push({ id: e.stepId, label: e.label, kind: e.kind, startedAt: e.startedAt, endedAt: now, ok: e.ok !== false, detail: e.detail });
  }
  return { ...state, [e.requestId]: steps };
}

export function runningSteps(steps: StepState[] | undefined): StepState[] {
  return (steps ?? []).filter((s) => s.endedAt === undefined && s.kind !== "notice");
}
export function problemSteps(steps: StepState[] | undefined): StepState[] {
  return (steps ?? []).filter((s) => s.kind !== "notice" && s.endedAt !== undefined && s.ok === false);
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "Researching eBay… 8s" (several at once are joined). Empty when nothing is running. */
export function statusText(steps: StepState[] | undefined, now: number): string {
  return runningSteps(steps)
    .map((s) => `${s.label}… ${formatElapsed(now - s.startedAt)}`)
    .join("  ·  ");
}
