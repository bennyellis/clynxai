// Optional protection of the saved API keys: only the three key lines change, a failed or unreadable protection changes nothing, the round trip is exact, and unreadable
// protected values read as "no key". Uses a fake cipher (nothing here is a real key and nothing touches the real .env).
import { envKeyState, isProtectedValue, protectEnvText, readEnvSecrets, unprotectEnvText } from "../envKeys.js";
import { protectSecret, revealSecret, setSecretCodec } from "../secretStore.js";
import { check, run, section } from "./_testkit.js";

const fake = { available: () => true, encrypt: (t: string) => Buffer.from(t.split("").reverse().join("")), decrypt: (b: Buffer) => b.toString().split("").reverse().join("") };

const ENV = [
  "# my notes",
  "OPENAI_API_KEY=sk-test-aaaaaaaaaaaaaaaaaaaa",
  "OTHER_SETTING=keep me",
  "EBAY_CLIENT_ID=ebay-id-123456",
  'EBAY_CLIENT_SECRET="ebay-secret-123456"',
  "",
].join("\n");

run(() => {
  setSecretCodec(fake);

  section("state");
  check("three plain keys, none protected", JSON.stringify(envKeyState(ENV)) === JSON.stringify({ plain: 3, protectedCount: 0 }), envKeyState(ENV));

  section("protecting");
  const p = protectEnvText(ENV, protectSecret, revealSecret);
  check("it worked and changed the three key lines", p.ok && p.changed === 3, p);
  if (!p.ok) return;
  check("no key remains readable in the file", !/sk-test-aaaa|ebay-id-123456|ebay-secret-123456/.test(p.text));
  check("every other line is exactly as it was", p.text.includes("# my notes") && p.text.includes("OTHER_SETTING=keep me"));
  check("the keys are marked protected", envKeyState(p.text).protectedCount === 3 && envKeyState(p.text).plain === 0);
  check("protecting twice changes nothing", protectEnvText(p.text, protectSecret, revealSecret).ok && (protectEnvText(p.text, protectSecret, revealSecret) as { changed: number }).changed === 0);

  section("reading back");
  const r = readEnvSecrets(p.text, revealSecret);
  check("decrypts to exactly the original keys (quotes removed as before)", r.values.OPENAI_API_KEY === "sk-test-aaaaaaaaaaaaaaaaaaaa" && r.values.EBAY_CLIENT_ID === "ebay-id-123456" && r.values.EBAY_CLIENT_SECRET === "ebay-secret-123456", r);
  check("nothing unreadable", r.unreadable.length === 0);

  section("turning it off");
  const u = unprotectEnvText(p.text, revealSecret);
  check("the keys are plain text again", u.ok && u.changed === 3 && /OPENAI_API_KEY=sk-test-aaaaaaaaaaaaaaaaaaaa/.test(u.text), u);
  check("the round trip loses no key", u.ok && JSON.stringify(readEnvSecrets(u.text, revealSecret).values) === JSON.stringify(readEnvSecrets(ENV, revealSecret).values));

  section("when things go wrong, nothing is changed");
  const unavailable = protectEnvText(ENV, (x) => x, revealSecret);
  check("a key store that does not encrypt is refused", !unavailable.ok);
  const lying = protectEnvText(ENV, (x) => "enc:v1:" + Buffer.from(x + "x").toString("base64"), () => "different");
  check("a copy that does not read back identical is refused", !lying.ok);
  setSecretCodec({ ...fake, available: () => false });
  const other = readEnvSecrets(p.text, revealSecret);
  check("protected keys that cannot be decrypted (another computer) read as no key, not a crash", Object.keys(other.values).length === 0 && other.unreadable.length === 3, other);
  check("and turning protection off does not destroy them", !unprotectEnvText(p.text, revealSecret).ok);
  setSecretCodec(fake);

  section("loading");
  check("a protected value is recognised so the plain loader can skip it", isProtectedValue("enc:v1:abc") && !isProtectedValue("sk-abc"));
});
