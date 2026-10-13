// One-time Owner setup, run ON THE SERVER by the person who operates it (it needs the server's database access; nothing on the website or in the app can do this).
//   npm run owner -- status
//   npm run owner -- begin  you@example.com            prints a one-time code (valid 15 minutes)
//   npm run owner -- complete you@example.com <code>    grants the Owner role
//   npm run owner -- revoke you@example.com --yes       removes it again
import { closePool } from "../db/client.js";
import { beginOwnerSetup, completeOwnerSetup, OwnerSetupError, ownerStatus, revokeOwner } from "../owner/service.js";

async function main() {
  const [cmd, email, extra] = process.argv.slice(2);
  if (cmd === "status") {
    const o = await ownerStatus();
    console.log(o ? `Owner: ${o.email}` : "No Owner has been set up.");
  } else if (cmd === "begin" && email) {
    const r = await beginOwnerSetup(email);
    console.log(`One-time code for ${email} (valid until ${r.expiresAt.toISOString()}):\n\n  ${r.code}\n\nNow run:  npm run owner -- complete ${email} <that code>\nThe code is shown only now and works once.`);
  } else if (cmd === "complete" && email && extra) {
    const r = await completeOwnerSetup(email, extra);
    console.log(`${r.email} is now the Owner. Every existing sign-in of that account was ended: sign in again.`);
  } else if (cmd === "revoke" && email && extra === "--yes") {
    await revokeOwner(email);
    console.log(`${email} is no longer the Owner.`);
  } else {
    console.error("usage: npm run owner -- status | begin <email> | complete <email> <code> | revoke <email> --yes");
    process.exitCode = 2;
  }
}
main()
  .catch((e) => {
    console.error(e instanceof OwnerSetupError ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
