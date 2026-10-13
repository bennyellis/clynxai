// The browser's only door to the server. Same origin, so the HttpOnly session cookie travels by itself; nothing secret is ever held in JavaScript. The one thing kept in memory is the
// CSRF token, which the server gives to a signed-in page and which must accompany every request that changes something.

let csrf: string | null = null;
export const setCsrf = (t: string | null) => {
  csrf = t;
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

const FRIENDLY: Record<string, string> = {
  "Invalid credentials": "That email and password do not match.",
  too_many_attempts: "Too many attempts. Please wait a few minutes and try again.",
  rate_limited: "Too many requests. Please wait a little while and try again.",
  account_disabled: "This account has been disabled. Please contact support.",
  "An account with this email already exists": "An account with this email already exists. Try signing in instead.",
  email_taken: "That email address belongs to another account.",
  email_not_verified: "Please confirm your email address first.",
  already_subscribed: "You already have a subscription.",
  billing_not_configured: "Payments are not switched on yet.",
  csrf: "Your session needs refreshing. Reload the page and try again.",
  invalid_or_expired_token: "This link is invalid or has expired.",
  provider_error: "The payment provider did not respond. Please try again.",
};

export async function api<T = unknown>(method: string, url: string, body?: unknown, init: { raw?: BodyInit; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...(init.headers ?? {}) };
  if (method !== "GET" && csrf) headers["X-CSRF-Token"] = csrf;
  let payload: BodyInit | undefined = init.raw;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network", "Could not reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const code = String(data.error ?? res.status);
    const message = FRIENDLY[code] ?? (typeof data.message === "string" ? data.message : null) ?? (res.status >= 500 ? "Something went wrong on our side. Please try again." : "That did not work.");
    throw new ApiError(res.status, code, message, data);
  }
  return data as T;
}

export const get = <T>(url: string) => api<T>("GET", url);
export const post = <T>(url: string, body?: unknown) => api<T>("POST", url, body ?? {});
export const patch = <T>(url: string, body: unknown) => api<T>("PATCH", url, body);
export const put = <T>(url: string, body: unknown) => api<T>("PUT", url, body);
export const del = <T>(url: string, body?: unknown) => api<T>("DELETE", url, body);

export const errorText = (e: unknown): string => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
