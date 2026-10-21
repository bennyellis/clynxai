// Owner decision Q5: a name the person TYPED (in chat) builds its card even in Save-credits mode, on a small allowance - one search per typed phrase (repeats are remembered) and a few an hour in all.
// Code deep in the search layer cannot be handed "this came from a typed name", so the research tool marks the work it starts, and the marker follows the async work it spawns.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<{ typed: true }>();

export const TYPED_LOW_AI_PER_HOUR = 6;

/** Runs `fn` (and everything it starts) as work for a name the person typed. */
export function runAsTypedName<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({ typed: true }, fn);
}
export const inTypedNameScope = (): boolean => scope.getStore()?.typed === true;

let capHitAt = 0;
/** The search layer declines a typed-name search because the small allowance is used up. */
export function noteTypedAllowanceUsed(now: number = Date.now()): void {
  capHitAt = now;
}
/** True once (and then resets) when a typed-name search was declined since the last call: the answer should say Save-credits mode is limiting it. */
export function consumeTypedAllowanceNotice(): boolean {
  const hit = capHitAt > 0;
  capHitAt = 0;
  return hit;
}

export const SAVE_CREDITS_NOTE = " Note for the user: Save-credits mode is on, so I could only do a very small amount of searching for this name and the card may be thin. Turning Save-credits mode off in Config lets me research it properly.";
