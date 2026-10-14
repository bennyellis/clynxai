// Server-side release tool (runs on the server computer, like the Owner tool). It PREPARES a release; it never approves or publishes one - that stays a deliberate step in the website
// console (approve, then publish by typing the version).
//
//   node dist/scripts/release.js list
//   node dist/scripts/release.js draft    --version 0.3.0-beta.2 --channel beta --file /tmp/Clynx-Beta-Setup-0.3.0-beta.2.exe [--notes-file n.txt] [--issues-file i.txt] [--expect-sha256 <hex>]
//   node dist/scripts/release.js template --version 0.3.0-beta.2 --channel beta            (prints the UNSIGNED update manifest; sign it offline with scripts/update-keys.cjs)
//   node dist/scripts/release.js attach   --version 0.3.0-beta.2 --channel beta --file /tmp/signed.json
import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { closePool, query } from "../db/client.js";
import { attachSignedManifest, manifestTemplate } from "../releases/manifestOps.js";
import { removeStored, saveStream } from "../releases/storage.js";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const need = (name: string): string => {
  const v = opt(name);
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
};

async function audit(action: string, target: string, detail: Record<string, unknown>): Promise<void> {
  await query("INSERT INTO admin_audit (admin_user_id, admin_email, action, target, detail) VALUES (NULL, $1, $2, $3, $4)", ["server release tool", action, target, JSON.stringify(detail)]);
}

async function findRelease(version: string, channel: string): Promise<{ id: string; status: string; storage_key: string | null } | null> {
  const r = await query<{ id: string; status: string; storage_key: string | null }>("SELECT id, status, storage_key FROM releases WHERE version = $1 AND channel = $2 AND platform = 'win32-x64'", [version, channel]);
  return r.rows[0] ?? null;
}

async function main(): Promise<void> {
  if (cmd === "list") {
    const r = await query("SELECT version, channel, status, file_name, sha256, size_bytes, (update_manifest IS NOT NULL) AS has_manifest, published_at FROM releases ORDER BY created_at DESC LIMIT 50");
    console.table(r.rows);
    return;
  }
  const version = need("version");
  const channel = need("channel");
  if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}(-[0-9A-Za-z.]{1,20})?$/.test(version) || !["beta", "stable"].includes(channel)) {
    console.error("use a version like 0.3.0-beta.2 and channel beta|stable");
    process.exit(2);
  }

  if (cmd === "draft") {
    const file = need("file");
    const expect = opt("expect-sha256")?.toLowerCase();
    const notes = opt("notes-file") ? readFileSync(opt("notes-file") as string, "utf-8").slice(0, 10_000) : "";
    const issues = opt("issues-file") ? readFileSync(opt("issues-file") as string, "utf-8").slice(0, 10_000) : "";
    statSync(file); // throws a clear error when the file is not there
    let rel = await findRelease(version, channel);
    let created = false;
    if (rel && rel.status !== "draft") {
      console.error(`Release ${version} (${channel}) already exists and is "${rel.status}". Only a draft can receive a file.`);
      process.exit(1);
    }
    if (!rel) {
      const ins = await query<{ id: string }>("INSERT INTO releases (version, channel, notes, known_issues) VALUES ($1, $2, $3, $4) RETURNING id", [version, channel, notes, issues]);
      rel = { id: ins.rows[0].id, status: "draft", storage_key: null };
      created = true;
    } else {
      await query("UPDATE releases SET notes = CASE WHEN $1 <> '' THEN $1 ELSE notes END, known_issues = CASE WHEN $2 <> '' THEN $2 ELSE known_issues END WHERE id = $3", [notes, issues, rel.id]);
    }
    const saved = await saveStream(rel.id, path.basename(file), createReadStream(file), config.web.maxReleaseBytes);
    if (expect && saved.sha256 !== expect) {
      removeStored(saved.key);
      if (created) await query("DELETE FROM releases WHERE id = $1", [rel.id]);
      console.error(`REFUSED: the file's SHA-256 is ${saved.sha256}, not the expected ${expect}. Nothing was kept.`);
      process.exit(1);
    }
    if (rel.storage_key && rel.storage_key !== saved.key) removeStored(rel.storage_key);
    await query("UPDATE releases SET storage_key = $1, file_name = $2, sha256 = $3, size_bytes = $4 WHERE id = $5", [saved.key, saved.key.split("/")[1], saved.sha256, saved.size, rel.id]);
    await audit("release.cli_draft", rel.id, { version, channel, sha256: saved.sha256, size: saved.size });
    console.log(JSON.stringify({ id: rel.id, status: "draft", version, channel, fileName: saved.key.split("/")[1], sizeBytes: saved.size, sha256: saved.sha256, matchedExpected: expect ? true : null }, null, 2));
    console.log("\nThis release is a DRAFT: it is not visible to anyone. Approve and publish it in the website console when you decide to.");
    return;
  }

  const rel = await findRelease(version, channel);
  if (!rel) {
    console.error(`No release ${version} on ${channel}. Run "draft" first.`);
    process.exit(1);
  }
  if (cmd === "template") {
    const r = await manifestTemplate(rel.id);
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(JSON.stringify(r.manifest, null, 2));
    return;
  }
  if (cmd === "attach") {
    const signed = JSON.parse(readFileSync(need("file"), "utf-8"));
    const r = await attachSignedManifest(rel.id, signed, null);
    if (!r.ok) {
      console.error(`REFUSED: ${r.message}`);
      process.exit(1);
    }
    await audit("release.cli_update_manifest", rel.id, { version, channel });
    console.log(`The signed manifest for ${version} (${channel}) was verified against the update public key and the stored installer, and kept.${r.willBeOffered ? " Clients on this channel are offered it." : " It is offered to clients once the release is published."}`);
    return;
  }
  console.error("usage: release.js list | draft | template | attach (see the header of this file)");
  process.exit(2);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
