// Phase 7: the cloud refresh token is encrypted on disk when the OS key store is available, and an older plain file still reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSession, writeSession } from "../cloudClient.js";
import { isProtectedSecret, protectSecret, revealSecret, setSecretCodec } from "../secretStore.js";
import { check, run, section } from "./_testkit.js";

// a stand-in cipher (reversible, obviously not the plain text)
const fakeCodec = (key: string, available = true) => ({
  available: () => available,
  encrypt: (t: string) => Buffer.from(`${key}|${Buffer.from(t).reverse().toString("latin1")}`, "latin1"),
  decrypt: (b: Buffer) => {
    const s = b.toString("latin1");
    if (!s.startsWith(`${key}|`)) throw new Error("wrong key");
    return Buffer.from(s.slice(key.length + 1), "latin1").reverse().toString();
  },
});

run(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-secret-"));
  const file = path.join(dir, "cloud-session.json");
  const session = { deviceId: "d1", refreshToken: "refresh-token-SECRET-123", userId: "u1", email: "a@example.com", apiUrl: "https://api.example" };

  section("with a key store");
  setSecretCodec(fakeCodec("K1"));
  const stored = protectSecret("hello");
  check("the stored form is marked and does not contain the secret", isProtectedSecret(stored) && !stored.includes("hello"));
  check("it round-trips", revealSecret(stored) === "hello");
  writeSession(file, session);
  const raw = fs.readFileSync(file, "utf-8");
  check("the session file on disk does not contain the refresh token", !raw.includes("refresh-token-SECRET-123") && raw.includes("enc:v1:"), raw);
  check("other fields stay readable", raw.includes("a@example.com") && raw.includes("d1"));
  const back = readSession(file);
  check("reading gives the original session back", JSON.stringify(back) === JSON.stringify(session), back);

  section("older and unusual files");
  fs.writeFileSync(file, JSON.stringify(session), "utf-8");
  check("an older plain-text file still reads", readSession(file).refreshToken === "refresh-token-SECRET-123");
  writeSession(file, readSession(file));
  check("and is rewritten encrypted on the next save", !fs.readFileSync(file, "utf-8").includes("refresh-token-SECRET-123"));
  setSecretCodec(fakeCodec("OTHER-MACHINE"));
  check("a file from another computer/account reads as signed out, not as a crash", readSession(file).refreshToken === null && readSession(file).userId === "u1");

  section("without a key store");
  setSecretCodec(fakeCodec("K1", false));
  check("nothing is encrypted and nothing breaks", protectSecret("x") === "x");
  check("an encrypted value cannot be read without the key store", revealSecret("enc:v1:AAAA") === null);
  setSecretCodec(null);
  check("no codec at all behaves the same", protectSecret("x") === "x" && revealSecret("plain") === "plain");
  setSecretCodec({ available: () => true, encrypt: () => { throw new Error("boom"); }, decrypt: () => "" });
  check("an encryption failure falls back to storing as before rather than losing the login", protectSecret("x") === "x");

  setSecretCodec(null);
  fs.rmSync(dir, { recursive: true, force: true });
});
