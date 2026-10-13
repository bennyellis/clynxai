// Phase 9: the support report must be useful to us and must never carry a secret.
import { buildSupportReport, redactSecrets, scrubText, REDACTED } from "../supportReport.js";
import { check, run, section } from "./_testkit.js";

run(() => {
  section("redaction");
  {
    const cfg = {
      openaiApiKey: "sk-live-abcdef1234567890abcdef",
      ntfy: { server: "https://ntfy.sh", topic: "my-private-topic-123" },
      cloud: { apiUrl: "https://api.example", refreshToken: "enc:v1:AAAABBBBCCCC" },
      account: { email: "person@example.com", password: "hunter2hunter2" },
      searchItems: [{ keywords: "ps5 console", maxPrice: 300 }],
      minProfitMarginPercent: 25,
      photoAnalysis: { enabled: true },
      note: "call me at person@example.com, auth Bearer abcdefghijklmnop1234",
    };
    const out = redactSecrets(cfg) as typeof cfg;
    const text = JSON.stringify(out);
    check("API keys, topics, tokens, passwords and emails are removed", !/sk-live|my-private-topic|AAAABBBB|hunter2|person@example/.test(text), text);
    check("ordinary settings stay readable (numbers, booleans, search terms)", out.minProfitMarginPercent === 25 && out.photoAnalysis.enabled === true && out.searchItems[0].keywords === "ps5 console" && out.ntfy.server === "https://ntfy.sh", out);
    check("a secret inside free text is scrubbed too", !/Bearer abcdefghijklmnop1234/.test(out.note) && /\[email\]/.test(out.note));
    check("redacted values are marked", (out.ntfy as { topic: string }).topic === REDACTED);
    check("booleans under secret-looking names are kept (they hold no secret)", (redactSecrets({ hasApiKey: true, tokenRefreshEnabled: false }) as { hasApiKey: boolean }).hasApiKey === true);
  }

  section("paths and tokens in text");
  {
    check("the user's name is removed from paths", !/biggt/i.test(scrubText("C:\\Users\\biggt\\AppData\\Roaming\\Clynx\\data and /Users/biggt/Library and /home/biggt/x")));
    check("the home folder given by the app is replaced", scrubText("opened C:\\Users\\Jo Smith\\Clynx\\scout.db", "C:\\Users\\Jo Smith") === "opened ~\\Clynx\\scout.db");
    check("JWTs and long hex secrets are removed", !/eyJ|0123456789abcdef0123456789abcdef01234567/.test(scrubText("t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def and 0123456789abcdef0123456789abcdef01234567")));
  }

  section("the report");
  {
    const report = buildSupportReport({
      generatedAt: "2026-10-13T12:00:00Z",
      app: { version: "0.2.0", electron: "44.2.0", platform: "win32", arch: "x64", packaged: true },
      config: { openaiApiKey: "sk-live-abcdef1234567890abcdef", theme: "dark" },
      diagnosticsTail: ['{"kind":"renderer-gone","path":"C:\\\\Users\\\\biggt\\\\x","who":"me@example.com"}', '{"kind":"ok"}'],
      notices: [{ id: "db-recovered", severity: "warning", title: "Started a fresh database", message: "Old copy kept." }],
      cloud: { authenticated: true, deviceId: "d1", accessToken: "abc123tokenvalue" },
      database: { bytes: 12345, backups: 2, newestBackupAt: "2026-10-12T08:00:00Z" },
      homeDir: "C:\\Users\\biggt",
    });
    check("the report has the headline facts", /Clynx support report/.test(report) && /"version": "0.2.0"/.test(report) && /Started a fresh database/.test(report) && /renderer-gone/.test(report));
    check("the report contains no secret, email or user name", !/sk-live|abc123tokenvalue|me@example|biggt/i.test(report), report.slice(0, 800));
    check("the report says what is left out", /NOT included/.test(report));
  }
});
