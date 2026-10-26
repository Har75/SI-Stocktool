import rateLimit from "express-rate-limit";

export const MAX_TICKERS = 20;

export function intEnv(env, name, fallback, { min = 1, max = 1_000_000 } = {}) {
  const raw = env?.[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export function readClientApiKey(req) {
  const header = req.get("x-api-key") || "";
  let fromBody = "";
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body) && req.body.apiKey != null) {
    fromBody = String(req.body.apiKey);
  }
  const key = (fromBody.trim() ? fromBody : header).trim();
  if (!key || key.length > 128 || /[\r\n]/.test(key)) return "";
  return key;
}

/**
 * Production never uses ALPHA_VANTAGE_API_KEY, including /api/test-connection.
 * The env key is a local Docker / development convenience only.
 */
export function resolveApiKey(req, env) {
  const client = readClientApiKey(req);
  if (client) return { ok: true, key: client, source: "client" };
  if (env.NODE_ENV !== "production") {
    const fromEnv = String(env.ALPHA_VANTAGE_API_KEY || "").trim();
    if (fromEnv) return { ok: true, key: fromEnv, source: "env" };
  }
  return { ok: false, key: null, source: null };
}

export function requestLogLine(req, res, ms) {
  return {
    method: req.method,
    path: req.path,
    status: res.statusCode,
    ms,
  };
}

export function scrub(value, secret) {
  if (typeof value === "string") {
    return secret ? value.split(secret).join("[redacted]") : value;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, secret));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api[-_]?key/i.test(key)) out[key] = "[redacted]";
    else out[key] = scrub(item, secret);
  }
  return out;
}

export function normalizeTickers(input) {
  if (!Array.isArray(input)) return { error: "tickers must be an array" };
  const tickers = [];
  const seen = new Set();
  for (const item of input) {
    const ticker = String(item ?? "")
      .trim()
      .toUpperCase();
    if (!ticker) continue;
    if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
      return { error: "Invalid ticker" };
    }
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    tickers.push(ticker);
  }
  if (tickers.length === 0) return { error: "Provide at least one ticker" };
  if (tickers.length > MAX_TICKERS) return { error: `tickers exceeds maximum of ${MAX_TICKERS}` };
  return { tickers };
}

export function buildCors(env) {
  const allowed = String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const production = env.NODE_ENV === "production";
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowed.includes(origin)) return callback(null, true);
      if (!production && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  };
}

export function apiLimiter(env, name, fallback) {
  return rateLimit({
    windowMs: intEnv(env, "RATE_LIMIT_WINDOW_MS", 60_000, { min: 1000, max: 3_600_000 }),
    limit: intEnv(env, name, fallback, { min: 1, max: 10_000 }),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests. Try again in a minute." },
  });
}
