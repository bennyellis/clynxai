// Server-side invitation tool (the website console does the same). The code is printed ONCE.
//   node dist/scripts/invite.js create [--email tester@example.com] [--hours 72] [--note "second PC"]
//   node dist/scripts/invite.js list
//   node dist/scripts/invite.js revoke <id>
import { createInvite } from "../access/invites.js";
import { closePool, query } from "../db/client.js";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function main(): Promise<void> {
  if (cmd === "create") {
    const hours = Number(opt("hours") ?? 72);
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) throw new Error("--hours must be between 1 and 720");
    const email = opt("email");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("--email is not an email address");
    const inv = await createInvite({ email: email ?? null, note: opt("note"), hours, createdBy: null });
    await query("INSERT INTO admin_audit (admin_user_id, admin_email, action, target, detail) VALUES (NULL, 'server invite tool', 'invite.create', $1, $2)", [inv.id, JSON.stringify({ email: email ?? null, hours })]);
    console.log(`\nInvitation code (shown only now):\n\n  ${inv.code}\n\nValid until ${inv.expiresAt.toISOString()}${email ? `, only for ${email}` : ""}. It works once. Send it privately.`);
  } else if (cmd === "list") {
    console.table((await query(`SELECT id, email, note, expires_at, used_at, revoked_at, CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN used_at IS NOT NULL THEN 'used' WHEN expires_at < now() THEN 'expired' ELSE 'open' END AS status FROM invites ORDER BY created_at DESC LIMIT 50`)).rows);
  } else if (cmd === "revoke" && rest[0]) {
    const r = await query("UPDATE invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL", [rest[0]]);
    console.log(r.rowCount ? "Revoked." : "Nothing to revoke (unknown, already used or revoked).");
  } else {
    console.error("usage: invite.js create [--email e] [--hours n] [--note t] | list | revoke <id>");
    process.exitCode = 2;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
