import type { PoolClient } from "pg";
import { getClient, query } from "../db/client.js";
import type { ProviderEvent } from "./provider.js";

// Applies provider webhook events to the subscriptions table: IDEMPOTENT (the event id is a primary key; a redelivery of a processed event does nothing, a delivery whose earlier
// processing failed is processed again) and ORDER-SAFE (an event older than the state already stored is ignored). The only writer of `subscriptions`.

export type EventOutcome = "applied" | "ignored-stale" | "ignored-unknown-user" | "ignored-type";
export type ApplyResult = { duplicate: true } | { duplicate: false; outcome: EventOutcome };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const secs = (v: unknown): Date | null => (typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000) : null);

interface SubRow {
  user_id: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  status: string;
  past_due_since: Date | null;
  last_event_created: string; // BIGINT arrives as a string
}

async function findRow(client: PoolClient, ids: { userId?: string | null; customerId?: string | null; subscriptionId?: string | null }): Promise<SubRow | null> {
  if (ids.subscriptionId) {
    const r = await client.query<SubRow>("SELECT * FROM subscriptions WHERE provider_subscription_id = $1", [ids.subscriptionId]);
    if (r.rows[0]) return r.rows[0];
  }
  if (ids.customerId) {
    const r = await client.query<SubRow>("SELECT * FROM subscriptions WHERE provider_customer_id = $1", [ids.customerId]);
    if (r.rows[0]) return r.rows[0];
  }
  if (ids.userId) {
    const r = await client.query<SubRow>("SELECT * FROM subscriptions WHERE user_id = $1", [ids.userId]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

async function userExists(client: PoolClient, userId: string): Promise<boolean> {
  return (await client.query("SELECT 1 FROM users WHERE id = $1", [userId])).rows.length > 0;
}

async function applyInTransaction(client: PoolClient, e: ProviderEvent): Promise<EventOutcome> {
  const o = e.object;
  switch (e.type) {
    case "checkout.session.completed": {
      const userId = str(o.client_reference_id);
      if (!userId || !UUID.test(userId) || !(await userExists(client, userId))) return "ignored-unknown-user";
      const customerId = str(o.customer);
      const subscriptionId = str(o.subscription);
      const existing = await findRow(client, { userId });
      if (existing && Number(existing.last_event_created) > e.created) return "ignored-stale";
      await client.query(
        `INSERT INTO subscriptions (user_id, provider_customer_id, provider_subscription_id, status, last_event_created)
         VALUES ($1, $2, $3, 'incomplete', $4)
         ON CONFLICT (user_id) DO UPDATE SET
           provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id),
           provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, subscriptions.provider_subscription_id),
           last_event_created = GREATEST(subscriptions.last_event_created, EXCLUDED.last_event_created),
           updated_at = now()`,
        [userId, customerId, subscriptionId, e.created]
      );
      return "applied";
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscriptionId = str(o.id);
      const customerId = str(o.customer);
      const metaUser = str((o.metadata as Record<string, unknown> | undefined)?.user_id);
      const row = await findRow(client, { userId: metaUser && UUID.test(metaUser) ? metaUser : null, customerId, subscriptionId });
      const userId = row?.user_id ?? (metaUser && UUID.test(metaUser) && (await userExists(client, metaUser)) ? metaUser : null);
      if (!userId) return "ignored-unknown-user";
      if (row && Number(row.last_event_created) > e.created) return "ignored-stale";
      const status = e.type === "customer.subscription.deleted" ? "canceled" : (str(o.status) ?? "incomplete");
      // which price (and so monthly or yearly) the subscription is on, from the provider's subscription object
      const price = ((o.items as { data?: Array<{ price?: { id?: unknown; recurring?: { interval?: unknown } } }> } | undefined)?.data ?? [])[0]?.price;
      const priceId = str(price?.id);
      const interval = str(price?.recurring?.interval);
      // past_due_since marks the moment payment first failed; it clears when the account is healthy again
      const pastDueSince = status === "past_due" ? (row?.status === "past_due" && row.past_due_since ? row.past_due_since : new Date(e.created * 1000)) : null;
      await client.query(
        `INSERT INTO subscriptions (user_id, provider_customer_id, provider_subscription_id, status, current_period_end, trial_end, cancel_at_period_end, past_due_since, last_event_created, price_id, billing_interval)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (user_id) DO UPDATE SET
           provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id),
           provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, subscriptions.provider_subscription_id),
           status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, trial_end = EXCLUDED.trial_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end, past_due_since = EXCLUDED.past_due_since,
           last_event_created = EXCLUDED.last_event_created, price_id = COALESCE(EXCLUDED.price_id, subscriptions.price_id),
           billing_interval = COALESCE(EXCLUDED.billing_interval, subscriptions.billing_interval), updated_at = now()`,
        [userId, customerId, subscriptionId, status, secs(o.current_period_end), secs(o.trial_end), o.cancel_at_period_end === true, pastDueSince, e.created, priceId, interval]
      );
      return "applied";
    }
    case "invoice.payment_failed":
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const row = await findRow(client, { customerId: str(o.customer), subscriptionId: str(o.subscription) });
      if (!row) return "ignored-unknown-user";
      if (Number(row.last_event_created) > e.created) return "ignored-stale";
      if (e.type === "invoice.payment_failed") {
        await client.query(
          `UPDATE subscriptions SET status = 'past_due', past_due_since = COALESCE(past_due_since, $2), last_event_created = $3, updated_at = now() WHERE user_id = $1`,
          [row.user_id, new Date(e.created * 1000), e.created]
        );
      } else if (row.status === "past_due") {
        await client.query(`UPDATE subscriptions SET status = 'active', past_due_since = NULL, last_event_created = $2, updated_at = now() WHERE user_id = $1`, [row.user_id, e.created]);
      } else {
        await client.query(`UPDATE subscriptions SET last_event_created = $2, updated_at = now() WHERE user_id = $1`, [row.user_id, e.created]);
      }
      return "applied";
    }
    default:
      return "ignored-type";
  }
}

export async function applyBillingEvent(e: ProviderEvent): Promise<ApplyResult> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    // The event id is the idempotency key. A redelivery of an event that was processed is a duplicate; one that was recorded but not processed (an earlier failure) is processed again.
    const ins = await client.query(
      `INSERT INTO billing_events (event_id, event_type, provider_created, payload) VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [e.id, e.type, e.created, JSON.stringify({ id: e.id, type: e.type, created: e.created, object: e.object })]
    );
    if (ins.rows.length === 0) {
      const prior = await client.query<{ processed_at: Date | null }>("SELECT processed_at FROM billing_events WHERE event_id = $1 FOR UPDATE", [e.id]);
      if (prior.rows[0]?.processed_at) {
        await client.query("COMMIT");
        return { duplicate: true };
      }
    }
    const outcome = await applyInTransaction(client, e);
    await client.query("UPDATE billing_events SET processed_at = now(), outcome = $2, error = NULL WHERE event_id = $1", [e.id, outcome]);
    await client.query("COMMIT");
    return { duplicate: false, outcome };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    // keep the event so the failure is visible and the provider's retry is processed again
    await query(
      `INSERT INTO billing_events (event_id, event_type, provider_created, payload, outcome, error) VALUES ($1, $2, $3, $4, 'error', $5)
       ON CONFLICT (event_id) DO UPDATE SET outcome = 'error', error = EXCLUDED.error`,
      [e.id, e.type, e.created, JSON.stringify({ id: e.id, type: e.type, created: e.created }), (err as Error).message.slice(0, 500)]
    ).catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
