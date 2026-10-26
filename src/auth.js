import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { intEnv } from "./http-security.js";

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const dummyHashes = new Map();

export function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return "";
  if (!EMAIL_RE.test(email)) return "";
  return email;
}

export function passwordIssue(password) {
  if (typeof password !== "string" || password.length === 0) return "Password is required";
  if (password.length < 10) return "Password must be at least 10 characters";
  if (Buffer.byteLength(password) > 72) return "Password must be at most 72 bytes";
  return "";
}

export function bcryptCost(env) {
  const raw = Number(env?.BCRYPT_COST);
  const chosen = Number.isInteger(raw) ? raw : 12;
  if (env?.NODE_ENV === "production") return Math.min(14, Math.max(12, chosen));
  return Math.min(14, Math.max(4, chosen));
}

export async function dummyPasswordHash(cost) {
  if (!dummyHashes.has(cost)) {
    dummyHashes.set(cost, await bcrypt.hash("dummy-password-not-a-user", cost));
  }
  return dummyHashes.get(cost);
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function sessionTtlMs(env) {
  const hours = intEnv(env, "SESSION_TTL_HOURS", 24 * 14, { min: 1, max: 24 * 90 });
  return hours * 60 * 60 * 1000;
}

export function cookieSecure(env) {
  if (env?.COOKIE_SECURE === "0") return false;
  if (env?.COOKIE_SECURE === "1") return true;
  return env?.NODE_ENV === "production";
}

export function sessionCookie(token, env, maxAgeSec) {
  const parts = [
    `si_session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSec}`,
  ];
  if (cookieSecure(env)) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(env) {
  const parts = ["si_session=", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (cookieSecure(env)) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header, name) {
  const source = String(header || "");
  for (const part of source.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return "";
    }
  }
  return "";
}

export function readBearer(header) {
  const match = String(header || "").match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/);
  return match ? match[1] : "";
}

export function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function newUser({ email, passwordHash, role, plan }) {
  return {
    id: randomUUID(),
    email,
    passwordHash,
    role: role === "admin" ? "admin" : "user",
    plan: plan === "pro" ? "pro" : "free",
    blocked: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: new Date().toISOString(),
  };
}

export function createSession(userId, env, nowMs = Date.now()) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("hex");
  return {
    token,
    csrfToken,
    session: {
      id: hashToken(token),
      userId,
      csrfToken,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: nowMs + sessionTtlMs(env),
    },
  };
}

export function rememberSession(state, session) {
  const now = Date.now();
  state.sessions = state.sessions.filter((item) => item.expiresAt > now);
  const mine = state.sessions.filter((item) => item.userId === session.userId);
  const overflow = mine.length - 9;
  if (overflow > 0) {
    const drop = new Set(
      mine
        .slice()
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .slice(0, overflow)
        .map((item) => item.id),
    );
    state.sessions = state.sessions.filter((item) => !drop.has(item.id));
  }
  state.sessions.push(session);
}

export function publicUser(user, { admin = false } = {}) {
  const view = {
    id: user.id,
    email: user.email,
    role: user.role === "admin" ? "admin" : "user",
    plan: user.plan === "pro" ? "pro" : "free",
    blocked: Boolean(user.blocked),
    hasBilling: Boolean(user.stripeCustomerId),
  };
  if (admin) view.stripeCustomerId = user.stripeCustomerId || null;
  return view;
}

export function isElevated(user) {
  if (!user || user.blocked) return false;
  return user.role === "admin" || user.plan === "pro";
}

export async function loadAuth(store, req, nowMs = Date.now()) {
  const bearer = readBearer(req.get("authorization"));
  const cookie = readCookie(req.headers.cookie, "si_session");
  const token = bearer || cookie;
  if (!token) return null;
  const id = hashToken(token);
  const state = await store.read();
  const session = state.sessions.find((item) => item.id === id && item.expiresAt > nowMs);
  if (!session) return null;
  const user = state.users.find((item) => item.id === session.userId);
  if (!user || user.blocked) return null;
  return { via: bearer ? "bearer" : "cookie", user, session };
}

export function csrfOk(req, auth) {
  if (!auth) return false;
  if (auth.via === "bearer") return true;
  return safeEqual(req.get("x-csrf-token") || "", auth.session.csrfToken || "");
}

export async function ensureAdmin(store, env) {
  const email = normalizeEmail(env.ADMIN_EMAIL || "");
  if (!email) return { status: "unset" };
  const password = typeof env.ADMIN_PASSWORD === "string" ? env.ADMIN_PASSWORD : "";
  const state = await store.read();
  const existing = state.users.find((user) => user.email === email);
  if (existing?.role === "admin") return { status: "ready" };
  if (existing) {
    await store.update((draft) => {
      const user = draft.users.find((item) => item.email === email);
      if (user) user.role = "admin";
    });
    console.log(JSON.stringify({ msg: "admin role ensured" }));
    return { status: "promoted" };
  }
  if (!password) {
    console.log(JSON.stringify({ msg: "admin seed skipped", reason: "set ADMIN_PASSWORD before exposing this service" }));
    return { status: "skipped" };
  }
  if (passwordIssue(password)) {
    console.log(JSON.stringify({ msg: "admin seed skipped", reason: "password rejected by policy" }));
    return { status: "rejected" };
  }
  const passwordHash = await bcrypt.hash(password, bcryptCost(env));
  await store.update((draft) => {
    if (draft.users.some((user) => user.email === email)) return;
    draft.users.push(newUser({ email, passwordHash, role: "admin", plan: "pro" }));
  });
  console.log(JSON.stringify({ msg: "admin seeded" }));
  return { status: "created" };
}
