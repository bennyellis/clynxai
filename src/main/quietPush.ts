// Owner decision Q4: a "Worth a look" with a LARGE gap but no sold prices behind its value is pushed to the phone QUIETLY (low priority), with a plain "not proven" warning, even when the general
// "also alert me about Worth a look" setting is off. Only for large gaps, never for an unsettled identity, and at most a few a day. Pure.
export interface QuietPushInput {
  status: string;
  basis: string | null;
  marginAtAskPercent: number | null;
  profitAtAskUsd: number | null;
  reasonCodes: ReadonlyArray<string>;
}

export const QUIET_PUSH_MIN_MARGIN_PERCENT = 50;
export const QUIET_PUSH_MIN_PROFIT_USD = 40;
export const QUIET_PUSH_PER_DAY = 5;

/** True when the value rests on no sold prices (asking prices only, the owner's own number, or nothing recorded). */
export const noSoldPrices = (basis: string | null) => basis === null || basis === "active" || basis === "user";

export function quietPushDecision(i: QuietPushInput, sentToday: number, minMarginPercent: number): { send: boolean; warning: string } {
  const warning = "Not proven: no sold prices behind this value, so it may be worth less than it looks.";
  if (i.status !== "worth_a_look" || !noSoldPrices(i.basis)) return { send: false, warning };
  if (i.reasonCodes.includes("IDENTITY_UNCONFIRMED")) return { send: false, warning };
  if (sentToday >= QUIET_PUSH_PER_DAY) return { send: false, warning };
  const bigMargin = i.marginAtAskPercent !== null && i.marginAtAskPercent >= Math.max(QUIET_PUSH_MIN_MARGIN_PERCENT, minMarginPercent * 2.5);
  const bigProfit = i.profitAtAskUsd !== null && i.profitAtAskUsd >= QUIET_PUSH_MIN_PROFIT_USD;
  return { send: bigMargin && bigProfit, warning };
}
