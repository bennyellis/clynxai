import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AccountError, checkLogin, emailSchema, passwordSchema, registerUser } from "../auth/accounts.js";
import { verifyAccessToken } from "../auth/service.js";
import { config } from "../config.js";
import { hit } from "../security/rateLimit.js";
import { createWebSession, lookupWebSession, originAllowed, readSessionCookie, setSessionCookie } from "../web/session.js";

// PRIVATE BETA GATE (ACCESS_MODE=private). The whole server, including the website, answers only to people who have signed in. What a visitor who is not signed in can reach:
//   * a small sign-in page (served by THIS file: no scripts, no website code, no data) and the two forms on it (sign in; create an account with an invitation code);
//   * the handful of endpoints a desktop app needs BEFORE it has a session: the address check (/server/info), liveness (/health), sign-in/refresh (/auth/*, rate limited);
//   * the payment provider's webhook (it authenticates itself with a signature) and /metrics (it needs its own token).
// Everything else - the website, release information and downloads, update manifests, plans, the API - needs a valid website session cookie OR a desktop bearer token. The desktop app sends
// its bearer token on every call (including update checks and the installer download), so the gate never has to be switched off for it. Nothing about who is approved is stored here: being
// approved means having an account, and with REGISTRATION=invite an account needs an invitation from the Owner.

export const OPEN_PATHS = new Set([
  "/health", "/health/ready", "/metrics", "/server/info", "/robots.txt",
  "/gate", "/gate/login", "/gate/join",
  "/auth/login", "/auth/register", "/auth/refresh", "/auth/logout",
  "/billing/webhook",
]);

export const isOpenPath = (urlPath: string): boolean => OPEN_PATHS.has(urlPath.length > 1 ? urlPath.replace(/\/+$/, "") : urlPath);

async function isAuthenticated(request: FastifyRequest): Promise<boolean> {
  const header = request.headers.authorization;
  if (header) {
    if (!header.startsWith("Bearer ")) return false;
    return !!(await verifyAccessToken(header.slice("Bearer ".length).trim()));
  }
  return !!(await lookupWebSession(readSessionCookie(request.headers.cookie)));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The only page an unauthenticated visitor ever gets. Self-contained: inline style, no script, no external resource. */
export function gatePage(opts: { error?: string; email?: string; tab?: "login" | "join" } = {}): string {
  const name = esc(config.web.serverName);
  const reg = config.web.registration;
  const joinOpen = reg !== "closed";
  const joinNeedsCode = reg === "invite";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>Private beta - ${name}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--text:#16181d;--muted:#5b6270;--line:#d9dde6;--accent:#4f46e5;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0e1015;--card:#171a21;--text:#eceef3;--muted:#9aa3b2;--line:#2a2f3a;--accent:#8b83ff;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,Segoe UI,sans-serif;padding:16px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:1.35rem;margin:0 0 4px}p{color:var(--muted);margin:4px 0 16px}label{display:block;font-weight:600;margin:12px 0 4px}
input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:inherit;font-weight:700;cursor:pointer}
details{margin-top:20px;border-top:1px solid var(--line);padding-top:12px}summary{cursor:pointer;font-weight:600}.err{color:var(--bad);font-weight:600;margin:0 0 12px}
</style></head><body><main>
<h1>${name}</h1><p>This is a private beta. Sign in to continue.</p>
${opts.error ? `<p class="err" role="alert">${esc(opts.error)}</p>` : ""}
<form method="post" action="/gate/login" autocomplete="on">
<label for="le">Email</label><input id="le" name="email" type="email" required autocomplete="username" value="${esc(opts.email ?? "")}">
<label for="lp">Password</label><input id="lp" name="password" type="password" required autocomplete="current-password">
<button type="submit">Sign in</button></form>
${joinOpen ? `<details${opts.tab === "join" ? " open" : ""}><summary>${joinNeedsCode ? "I have an invitation" : "Create an account"}</summary>
<form method="post" action="/gate/join" autocomplete="on">
<label for="je">Email</label><input id="je" name="email" type="email" required autocomplete="username" value="${opts.tab === "join" ? esc(opts.email ?? "") : ""}">
<label for="jp">Choose a password (8 or more characters)</label><input id="jp" name="password" type="password" required minlength="8" autocomplete="new-password">
${joinNeedsCode ? `<label for="jc">Invitation code</label><input id="jc" name="inviteCode" type="text" required autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX">` : ""}
<button type="submit">Create account</button></form></details>` : ""}
</main></body></html>`;
}

const GATE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function sendGate(reply: FastifyReply, status: number, opts: Parameters<typeof gatePage>[0] = {}) {
  reply.header("Content-Type", "text/html; charset=utf-8");
  reply.header("Cache-Control", "no-store");
  reply.header("Content-Security-Policy", GATE_CSP);
  return reply.code(status).send(gatePage(opts));
}

const wantsHtml = (request: FastifyRequest) => (request.method === "GET" || request.method === "HEAD") && String(request.headers.accept ?? "").includes("text/html");

export function registerAccessGate(app: FastifyInstance): void {
  // runs for every request, before routing
  app.addHook("onRequest", async (request, reply) => {
    if (!config.web.accessPrivate) return;
    const urlPath = request.url.split("?")[0];
    if (urlPath === "/robots.txt") {
      reply.header("Content-Type", "text/plain; charset=utf-8");
      return reply.code(200).send("User-agent: *\nDisallow: /\n");
    }
    if (isOpenPath(urlPath)) return;
    if (!(await isAuthenticated(request))) {
      // how often one address may knock on a locked door (signed-in people are not counted)
      const rl = await hit(`gate:anon:${request.ip}`, 300, 60);
      if (!rl.allowed) return reply.code(429).header("Retry-After", String(rl.retryAfterSec)).send({ error: "rate_limited" });
      if (wantsHtml(request)) return sendGate(reply, 401);
      return reply.code(401).send({ error: "private_beta", message: "Sign in to continue." });
    }
  });

  app.register(async (g) => {
    g.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 8 * 1024 }, (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error);
      }
    });

    g.get("/gate", async (request, reply) => {
      if (await isAuthenticated(request)) return reply.code(303).header("Location", "/").send();
      return sendGate(reply, 200);
    });

    const throttle = async (request: FastifyRequest, reply: FastifyReply, form: { email?: string; tab?: "login" | "join" }) => {
      const rl = await hit(`gate:post:${request.ip}`, 40, 900);
      if (!rl.allowed) {
        reply.header("Retry-After", String(rl.retryAfterSec));
        sendGate(reply, 429, { ...form, error: "Too many attempts from this address. Wait a few minutes and try again." });
        return false;
      }
      if (!originAllowed(request)) {
        sendGate(reply, 403, { ...form, error: "That request came from another website and was refused." });
        return false;
      }
      return true;
    };

    const accountError = (reply: FastifyReply, err: unknown, form: { email?: string; tab: "login" | "join" }) => {
      if (!(err instanceof AccountError)) throw err;
      const code = err.body.error;
      let msg = "That did not work. Check what you typed and try again.";
      if (err.status === 401) msg = "That email or password is not right.";
      else if (err.status === 429) msg = "Too many attempts. Wait a few minutes and try again.";
      else if (code === "account_disabled") msg = "This account is disabled.";
      else if (code === "invitation_required") msg = String(err.body.message ?? "An invitation code is needed.");
      else if (code === "registration_closed") msg = "New accounts are not being created right now.";
      else if (err.status === 409) msg = "An account with that email already exists. Sign in instead.";
      if (err.retryAfterSec) reply.header("Retry-After", String(err.retryAfterSec));
      return sendGate(reply, err.status === 429 ? 429 : err.status === 401 ? 401 : 400, { ...form, error: msg });
    };

    g.post("/gate/login", async (request, reply) => {
      const raw = (request.body ?? {}) as Record<string, unknown>;
      const form = { email: typeof raw.email === "string" ? raw.email.slice(0, 254) : "", tab: "login" as const };
      if (!(await throttle(request, reply, form))) return reply;
      const parsed = z.object({ email: emailSchema, password: z.string().min(1).max(200) }).safeParse(raw);
      if (!parsed.success) return sendGate(reply, 400, { ...form, error: "Enter your email and password." });
      try {
        const user = await checkLogin(parsed.data.email, parsed.data.password, request.ip);
        const s = await createWebSession(user.id, request.headers["user-agent"]);
        setSessionCookie(reply, s.cookieValue, request);
        return reply.code(303).header("Location", "/").header("Cache-Control", "no-store").send();
      } catch (err) {
        return accountError(reply, err, form);
      }
    });

    g.post("/gate/join", async (request, reply) => {
      const raw = (request.body ?? {}) as Record<string, unknown>;
      const form = { email: typeof raw.email === "string" ? raw.email.slice(0, 254) : "", tab: "join" as const };
      if (!(await throttle(request, reply, form))) return reply;
      const parsed = z.object({ email: emailSchema, password: passwordSchema, inviteCode: z.string().max(40).optional() }).safeParse(raw);
      if (!parsed.success) return sendGate(reply, 400, { ...form, error: "Enter a valid email and a password of at least 8 characters." });
      try {
        const userId = await registerUser(parsed.data.email, parsed.data.password, request.ip, undefined, parsed.data.inviteCode);
        const s = await createWebSession(userId, request.headers["user-agent"]);
        setSessionCookie(reply, s.cookieValue, request);
        return reply.code(303).header("Location", "/").header("Cache-Control", "no-store").send();
      } catch (err) {
        return accountError(reply, err, form);
      }
    });
  });
}
