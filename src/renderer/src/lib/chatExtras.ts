import { useSyncExternalStore } from "react";
import { api } from "./api.js";
import type { ChatChoice } from "./api.js";
import { applyStatusEvent, type RequestSteps } from "./chatStatus.js";

// Beta 13: the per-turn extras every chat shares - real progress steps and the buttons of a question - kept in ONE module-level store that listens to the app's events once. A
// chat screen asks it about its own request ids; nothing here is stored in a chat's message list or sent back to the model. Discovery, Activity, the global bar and a product's
// chat can all stream at the same time: events carry their request id, so they never mix.

interface Snapshot {
  steps: RequestSteps;
  choices: Record<string, ChatChoice>;
}
let snapshot: Snapshot = { steps: {}, choices: {} };
const listeners = new Set<() => void>();
let started = false;

function emit(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

function ensureListening() {
  if (started) return;
  started = true;
  api.onChatStatus((e) => emit({ ...snapshot, steps: applyStatusEvent(snapshot.steps, e, Date.now()) }));
  api.onChatChoices((requestId, choice) => emit({ ...snapshot, choices: { ...snapshot.choices, [requestId]: choice } }));
}

export function useChatExtras(): Snapshot {
  ensureListening();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot
  );
}

/** The buttons of a question stop being offered once the person has answered (or typed instead), and a finished turn's steps are dropped. */
export function dismissChoice(requestId: string) {
  if (!snapshot.choices[requestId]) return;
  const { [requestId]: _gone, ...rest } = snapshot.choices;
  emit({ ...snapshot, choices: rest });
}
export function forgetSteps(requestId: string) {
  if (!snapshot.steps[requestId]) return;
  const { [requestId]: _gone, ...rest } = snapshot.steps;
  emit({ ...snapshot, steps: rest });
}
export function dismissAllChoices() {
  if (Object.keys(snapshot.choices).length) emit({ ...snapshot, choices: {} });
}
