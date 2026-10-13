// Administrator accounts are made from the command line, on the server, never through the website:
//   npm run admin -- list
//   npm run admin -- promote someone@example.com
//   npm run admin -- demote someone@example.com
import { closePool, query } from "../db/client.js";

async function main() {
  const [cmd, email] = process.argv.slice(2);
  if (cmd === "list") {
    const r = await query<{ email: string; created_at: Date }>("SELECT email, created_at FROM users WHERE role = 'admin' ORDER BY created_at");
    console.log(r.rows.length ? r.rows.map((u) => `${u.email}  (since ${u.created_at.toISOString().slice(0, 10)})`).join("\n") : "No administrators.");
  } else if ((cmd === "promote" || cmd === "demote") && email) {
    const r = await query("UPDATE users SET role = $1 WHERE lower(email) = lower($2)", [cmd === "promote" ? "admin" : "user", email]);
    console.log(r.rowCount ? `${email} is now ${cmd === "promote" ? "an administrator" : "an ordinary user"}.` : `No account with the address ${email}.`);
    process.exitCode = r.rowCount ? 0 : 1;
  } else {
    console.error("usage: npm run admin -- list | promote <email> | demote <email>");
    process.exitCode = 2;
  }
  await closePool();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
