// Release tooling for the signed-update design (src/main/updateVerifier.ts). Nothing here runs inside the app.
//
//   node scripts/update-keys.cjs keygen <dir>                                    writes <dir>/update-private.pem and update-public.pem (keep the private one OFFLINE, never in git)
//   node scripts/update-keys.cjs sign <private.pem> <manifest.json> <out.json>   signs a manifest -> { manifest, signature }
//   node scripts/update-keys.cjs hash <file>                                     prints the size and SHA-512 (hex) to put into a manifest
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === "keygen" && a) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, "update-private.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(path.join(a, "update-public.pem"), publicKey.export({ type: "spki", format: "pem" }));
  console.log(`Wrote update-private.pem (secret) and update-public.pem to ${a}`);
} else if (cmd === "sign" && a && b && c) {
  const text = JSON.stringify(JSON.parse(fs.readFileSync(b, "utf-8")));
  const signature = crypto.sign(null, Buffer.from(text, "utf-8"), crypto.createPrivateKey(fs.readFileSync(a))).toString("base64");
  fs.writeFileSync(c, JSON.stringify({ manifest: text, signature }, null, 2));
  console.log(`Signed manifest written to ${c}`);
} else if (cmd === "hash" && a) {
  const data = fs.readFileSync(a);
  console.log(JSON.stringify({ name: path.basename(a), size: data.length, sha512: crypto.createHash("sha512").update(data).digest("hex") }, null, 2));
} else {
  console.error("usage: update-keys.cjs keygen <dir> | sign <private.pem> <manifest.json> <out.json> | hash <file>");
  process.exit(2);
}
