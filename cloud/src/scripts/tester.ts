// Beta testers are ordinary accounts with every plan limit lifted. They are made on the server, from the command line, never through the website and never by
// the person themselves (so an administrator or a tester cannot grant it):
//   npm run tester -- list
//   npm run tester -- add someone@example.com
//   npm run tester -- remove someone@example.com        (back to the free plan; any subscription they pay for still applies)
// A tester has NO administrator or Owner rights and cannot open the website console. The infrastructure safety limits that protect the shared service still apply.
import { closePool, query } from "../db/client.js";

async function main(): Promise<void> {
  const [cmd, email] = process.argv.slice(2);
  if (cmd === "list") {
    const r = await query<{ email: string; created_at: Date }>("SELECT email, created_at FROM users WHERE plan = 'tester' ORDER BY created_at");
    console.log(r.rows.length ? r.rows.map((u) => `${u.email}  (account since ${u.created_at.toISOString().slice(0, 10)})`).join("\n") : "No beta testers.");
  } else if ((cmd === "add" || cmd === "remove") && email) {
    // Never touches an administrator's or the Owner's account: those have their own roles, and a tester plan on them would only be confusing.
    const found = await query<{ id: string; role: string; plan: string }>("SELECT id, role, plan FROM users WHERE lower(email) = lower($1)", [email]);
    const u = found.rows[0];
    if (!u) {
      console.log(`No account with the address ${email}. They need to register first.`);
      process.exitCode = 1;
    } else if (u.role !== "user") {
      console.log(`${email} is an ${u.role}; testers are ordinary accounts, so nothing was changed.`);
      process.exitCode = 1;
    } else {
      const plan = cmd === "add" ? "tester" : "free";
      if (cmd === "remove" && u.plan !== "tester") {
        console.log(`${email} is not a beta tester.`);
      } else {
        await query("UPDATE users SET plan = $1 WHERE id = $2", [plan, u.id]);
        await query("INSERT INTO admin_audit (admin_user_id, admin_email, action, target, detail) VALUES (NULL, 'server tester tool', $1, $2, $3)", [`tester.${cmd}`, u.id, JSON.stringify({ email })]);
        console.log(cmd === "add" ? `${email} is now a beta tester: no plan limits, no administrator rights.` : `${email} is back on the free plan.`);
      }
    }
  } else {
    console.error("usage: npm run tester -- list | add <email> | remove <email>");
    process.exitCode = 2;
  }
  await closePool();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
