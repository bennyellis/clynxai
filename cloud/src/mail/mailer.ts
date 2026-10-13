import nodemailer from "nodemailer";
import { config } from "../config.js";
import { query } from "../db/client.js";

// Outgoing email. Every message is first written to email_outbox (the record), then delivered when SMTP_URL is configured. Without SMTP nothing leaves the server: the row is marked
// "captured", which is what development and the tests read. A delivery failure never fails the request that wanted the email; it is recorded and visible to administrators.

let transport: nodemailer.Transporter | null = null;
function getTransport(): nodemailer.Transporter | null {
  if (!config.web.smtpUrl) return null;
  transport ??= nodemailer.createTransport(config.web.smtpUrl);
  return transport;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  purpose: string;
}

export async function queueEmail(m: OutgoingEmail): Promise<void> {
  const t = getTransport();
  const row = await query<{ id: string }>(
    "INSERT INTO email_outbox (to_email, subject, body, purpose, status) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [m.to, m.subject, m.body, m.purpose, t ? "queued" : "captured"]
  );
  if (!t) return;
  const id = row.rows[0].id;
  try {
    await t.sendMail({ from: config.web.mailFrom, to: m.to, subject: m.subject, text: m.body });
    await query("UPDATE email_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1", [id]);
  } catch (err) {
    await query("UPDATE email_outbox SET status = 'failed', attempts = attempts + 1, error = $2 WHERE id = $1", [id, String((err as Error).message).slice(0, 300)]).catch(() => undefined);
  }
}

// ---- the messages (plain text on purpose: nothing to render wrongly, nothing to track)
const sign = `\n\n-- Clynx\nIf you did not expect this email you can ignore it.`;

export const emails = {
  verify: (to: string, token: string): OutgoingEmail => ({
    to,
    purpose: "verify_email",
    subject: "Confirm your Clynx email address",
    body: `Welcome to Clynx.\n\nConfirm your email address by opening this link (valid for 24 hours):\n${config.web.publicUrl}/verify-email?token=${token}${sign}`,
  }),
  reset: (to: string, token: string): OutgoingEmail => ({
    to,
    purpose: "reset_password",
    subject: "Reset your Clynx password",
    body: `Someone asked to reset the password for this Clynx account. If that was you, open this link within one hour:\n${config.web.publicUrl}/reset-password?token=${token}\n\nYour current password keeps working until you finish the reset.${sign}`,
  }),
  changeEmail: (to: string, token: string): OutgoingEmail => ({
    to,
    purpose: "change_email",
    subject: "Confirm your new Clynx email address",
    body: `Confirm that this is your new email address for Clynx (valid for 24 hours):\n${config.web.publicUrl}/confirm-email-change?token=${token}${sign}`,
  }),
  emailChanged: (to: string, newAddress: string): OutgoingEmail => ({
    to,
    purpose: "email_changed_notice",
    subject: "Your Clynx email address was changed",
    body: `The email address on your Clynx account was changed to ${newAddress}. If this was not you, contact ${config.web.supportEmail} straight away.`,
  }),
  passwordChanged: (to: string): OutgoingEmail => ({
    to,
    purpose: "password_changed_notice",
    subject: "Your Clynx password was changed",
    body: `The password for your Clynx account was just changed and you were signed out everywhere. If this was not you, reset it now at ${config.web.publicUrl}/forgot-password and contact ${config.web.supportEmail}.`,
  }),
  supportReceived: (to: string, id: string, subject: string): OutgoingEmail => ({
    to,
    purpose: "support_received",
    subject: `We received your request: ${subject.slice(0, 80)}`,
    body: `Thanks for contacting Clynx support. Your reference is ${id}. We will reply to this address.${sign}`,
  }),
};
