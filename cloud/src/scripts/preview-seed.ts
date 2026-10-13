// Fills a LOCAL PREVIEW database with demonstration accounts so the website can be tried end to end. Never run this against a real database.
//   npm run preview:seed [-- --installer C:\path\Clynx-Beta-Setup.exe]
// Accounts (all use the password shown below - local preview only):
//   owner@preview.clynx.invalid     the Owner (set up through the same one-time tool a real deployment uses)
//   admin@preview.clynx.invalid     an administrator (NOT the Owner: no free plan)
//   customer@preview.clynx.invalid  an ordinary customer on the free plan
// With --installer the file is copied into the preview release store as a DRAFT release. It is NOT approved or published; that stays a deliberate step in the console.
import { createReadStream, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { hashPassword } from "../auth/service.js";
import { config } from "../config.js";
import { closePool, query } from "../db/client.js";
import { beginOwnerSetup, completeOwnerSetup, ownerStatus } from "../owner/service.js";
import { saveStream } from "../releases/storage.js";

if (!/localhost|127\.0\.0\.1/.test(config.databaseUrl) || config.web.production) {
  console.error("Refusing to seed: this is only for a local preview database.");
  process.exit(2);
}
const PASSWORD = "preview-password-1";

async function ensure(email: string, name: string): Promise<string> {
  const e = await query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [email]);
  if (e.rows[0]) return e.rows[0].id;
  const r = await query<{ id: string }>("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id", [email, await hashPassword(PASSWORD), name]);
  return r.rows[0].id;
}

const ownerId = await ensure("owner@preview.clynx.invalid", "Preview Owner");
const adminId = await ensure("admin@preview.clynx.invalid", "Preview Admin");
await ensure("customer@preview.clynx.invalid", "Preview Customer");
await query("UPDATE users SET role = 'admin' WHERE id = $1", [adminId]);
if (!(await ownerStatus())) {
  const { code } = await beginOwnerSetup("owner@preview.clynx.invalid");
  await completeOwnerSetup("owner@preview.clynx.invalid", code);
}

const i = process.argv.indexOf("--installer");
if (i > 0 && process.argv[i + 1]) {
  const file = path.resolve(process.argv[i + 1]);
  const version = "0.3.0-beta.1";
  const exists = await query("SELECT 1 FROM releases WHERE version = $1 AND channel = 'beta'", [version]);
  if (!exists.rows.length) {
    const r = await query<{ id: string }>(
      "INSERT INTO releases (version, channel, notes, known_issues, created_by) VALUES ($1, 'beta', $2, $3, $4) RETURNING id",
      [version, "First Windows beta: local mode with no account, Chrome/Edge detection, automatic Database backups, support report.", "Unsigned installer (Windows SmartScreen warns). Needs Google Chrome or Microsoft Edge. Bring your own OpenAI key in local mode.", ownerId]
    );
    mkdirSync(path.resolve(config.web.releasesDir), { recursive: true });
    const saved = await saveStream(r.rows[0].id, path.basename(file), createReadStream(file), statSync(file).size + 1024);
    await query("UPDATE releases SET storage_key = $1, file_name = $2, sha256 = $3, size_bytes = $4 WHERE id = $5", [saved.key, path.basename(saved.key), saved.sha256, saved.size, r.rows[0].id]);
    console.log(`registered DRAFT release ${version} (${saved.size} bytes, sha256 ${saved.sha256}); not approved, not public`);
  }
}
console.log(`preview accounts ready. Password for all: ${PASSWORD}`);
await closePool();
