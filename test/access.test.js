import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Stripe from "stripe";
import { applyStripeEvent } from "../src/billing.js";
import { createApp } from "../src/server.js";
import { MemoryStore } from "../src/store.js";

const PASSWORD = "correct-horse-1";
const STRIPE_KEY = "sk_test_example";
const WEBHOOK_SECRET = "whsec_test_secret_for_unit_tests_only";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function testEnv(extra = {}) {
  return { NODE_ENV: "test", BCRYPT_COST: "4", ...extra };
}

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function withServer(app, fn) {
  const started = await listen(app);
  try {
    return await fn(started);
  } finally {
    started.server.close();
    await once(started.server, "close");
  }
}

function cookieFrom(response) {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}

async function signUp(url, email, password = PASSWORD) {
  const response = await fetch(`${url}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, role: "admin", plan: "pro" }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return {
    response,
    body,
    cookie: cookieFrom(response),
    csrf: body.csrfToken,
    token: body.token,
    user: body.user,
  };
}

function authHeaders(session, { json = true, bearer = false, csrf = true } = {}) {
  const headers = {};
  if (json) headers["content-type"] = "application/json";
  if (bearer) headers.authorization = `Bearer ${session.token}`;
  else headers.cookie = session.cookie;
  if (csrf && !bearer) headers["x-csrf-token"] = session.csrf;
  return headers;
}

function signedEvent(event) {
  const payload = JSON.stringify(event);
  const stripe = new Stripe(STRIPE_KEY);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

const overview = {
  Symbol: "NOK",
  Name: "Sample Co",
  OperatingMarginTTM: "0.11",
  ProfitMargin: "0.09",
  ReturnOnEquityTTM: "0.14",
  QuarterlyEarningsGrowthYOY: "0.04",
  DividendYield: "0.03",
  PERatio: "16",
};

function avFetch(url) {
  const name = new URL(String(url)).searchParams.get("function");
  const bodies = {
    OVERVIEW: overview,
    INCOME_STATEMENT: {
      annualReports: [{ totalRevenue: "110.25" }, { totalRevenue: "105" }, { totalRevenue: "100" }],
    },
    BALANCE_SHEET: {
      annualReports: [
        { totalShareholderEquity: "80", shortLongTermDebtTotal: "32", commonStockSharesOutstanding: "990" },
        { commonStockSharesOutstanding: "1000" },
      ],
    },
    CASH_FLOW: {
      annualReports: [{ operatingCashflow: "12", capitalExpenditures: "-3.18" }],
    },
  };
  return jsonResponse(bodies[name] || {});
}

test("signup stores a bcrypt hash and a session hash, not the password or token", async () => {
  const store = new MemoryStore();
  const app = createApp({ env: testEnv(), store, fetchImpl: async () => jsonResponse({}) });
  await withServer(app, async ({ url }) => {
    const session = await signUp(url, "ada@example.com");
    assert.equal(session.user.role, "user");
    assert.equal(session.user.plan, "free");
    assert.equal(JSON.stringify(session.body).includes(PASSWORD), false);
    assert.equal(JSON.stringify(session.body).includes("passwordHash"), false);
    const setCookie = session.response.headers.getSetCookie().join(" ");
    assert.match(setCookie, /si_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.equal(setCookie.includes("Secure"), false);
    const state = await store.read();
    const saved = JSON.stringify(state);
    assert.equal(saved.includes(PASSWORD), false);
    assert.equal(saved.includes(session.token), false);
    assert.match(state.users[0].passwordHash, /^\$2[ab]\$04\$/);
    assert.notEqual(state.sessions[0].id, session.token);
    assert.match(state.sessions[0].id, /^[a-f0-9]{64}$/);
  });
});

test("production cookies are Secure and bcrypt cost stays at least 12", async () => {
  const store = new MemoryStore();
  const app = createApp({
    env: { NODE_ENV: "production", BCRYPT_COST: "4" },
    store,
    fetchImpl: async () => jsonResponse({}),
  });
  await withServer(app, async ({ url }) => {
    const session = await signUp(url, "prod@example.com");
    const setCookie = session.response.headers.getSetCookie().join(" ");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    const state = await store.read();
    assert.match(state.users[0].passwordHash, /^\$2[ab]\$12\$/);
  });
});

test("search and quotes stay public while analyze and watchlist are gated", async () => {
  let calls = 0;
  const app = createApp({
    env: testEnv(),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ bestMatches: [], "Global Quote": { "01. symbol": "NOK", "05. price": "4.50" } });
    },
  });
  await withServer(app, async ({ url }) => {
    const replay = await fetch(`${url}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticker: "NOK", replay: true }),
    });
    assert.equal(replay.status, 401);
    assert.equal((await replay.text()).includes("pillars"), false);
    assert.equal(calls, 0);

    const free = await signUp(url, "free@example.com");
    const denied = await fetch(`${url}/api/analyze`, {
      method: "POST",
      headers: authHeaders(free),
      body: JSON.stringify({ ticker: "NOK", replay: true }),
    });
    const deniedBody = await denied.json();
    assert.equal(denied.status, 403);
    assert.equal(deniedBody.error, "Pro plan required");
    assert.equal(JSON.stringify(deniedBody).includes("composite"), false);

    const watch = await fetch(`${url}/api/watchlist`, { headers: { cookie: free.cookie } });
    assert.equal(watch.status, 403);

    const search = await fetch(`${url}/api/search?keywords=nokia`, { headers: { "x-api-key": "client-key" } });
    assert.equal(search.status, 200);
    const quotes = await fetch(`${url}/api/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-key" },
      body: JSON.stringify({ tickers: ["NOK"] }),
    });
    assert.equal(quotes.status, 200);
  });
});

test("admin can promote and block; a blocked user loses the session", async () => {
  const app = createApp({
    env: testEnv({ ADMIN_EMAIL: "harald@example.com" }),
    fetchImpl: async () => jsonResponse({}),
  });
  await withServer(app, async ({ url }) => {
    const admin = await signUp(url, "harald@example.com");
    assert.equal(admin.user.role, "admin");
    const user = await signUp(url, "reader@example.com");
    assert.equal(user.user.role, "user");
    assert.equal(user.user.plan, "free");

    const hidden = await fetch(`${url}/api/admin/users`, { headers: { cookie: user.cookie } });
    assert.equal(hidden.status, 403);

    const listed = await fetch(`${url}/api/admin/users`, { headers: { cookie: admin.cookie } });
    const users = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(JSON.stringify(users).includes(PASSWORD), false);
    assert.equal(JSON.stringify(users).includes("passwordHash"), false);

    const selfBlock = await fetch(`${url}/api/admin/users/${admin.user.id}`, {
      method: "POST",
      headers: authHeaders(admin),
      body: JSON.stringify({ blocked: true, role: "user" }),
    });
    assert.equal(selfBlock.status, 400);

    const promoted = await fetch(`${url}/api/admin/users/${user.user.id}`, {
      method: "POST",
      headers: authHeaders(admin),
      body: JSON.stringify({ plan: "pro", role: "admin" }),
    });
    const promotedBody = await promoted.json();
    assert.equal(promoted.status, 200);
    assert.equal(promotedBody.user.plan, "pro");
    assert.equal(promotedBody.user.role, "user");
    const scored = await fetch(`${url}/api/analyze`, {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify({ ticker: "NOK", replay: true }),
    });
    assert.equal(scored.status, 200);
    assert.equal((await scored.json()).composite, 69);

    const demoted = await fetch(`${url}/api/admin/users/${user.user.id}`, {
      method: "POST",
      headers: authHeaders(admin),
      body: JSON.stringify({ plan: "free" }),
    });
    assert.equal(demoted.status, 200);
    const blockedScore = await fetch(`${url}/api/analyze`, {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify({ ticker: "NOK", replay: true }),
    });
    assert.equal(blockedScore.status, 403);

    const blocked = await fetch(`${url}/api/admin/users/${user.user.id}`, {
      method: "POST",
      headers: authHeaders(admin),
      body: JSON.stringify({ blocked: true }),
    });
    assert.equal(blocked.status, 200);
    const me = await fetch(`${url}/api/auth/me`, { headers: { cookie: user.cookie } });
    assert.equal((await me.json()).user, null);
    const login = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.com", password: PASSWORD }),
    });
    assert.equal(login.status, 403);
  });
});

test("watchlist CRUD keeps previous composite and requires CSRF for cookies", async () => {
  const app = createApp({
    env: testEnv({ ADMIN_EMAIL: "owner@example.com" }),
    fetchImpl: async () => jsonResponse({}),
  });
  await withServer(app, async ({ url }) => {
    const session = await signUp(url, "owner@example.com");
    const missingCsrf = await fetch(`${url}/api/watchlist`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session.cookie },
      body: JSON.stringify({ ticker: "NOK", composite: 10, note: "first" }),
    });
    assert.equal(missingCsrf.status, 403);

    const added = await fetch(`${url}/api/watchlist`, {
      method: "POST",
      headers: authHeaders(session),
      body: JSON.stringify({ ticker: "nok", label: "Nokia", composite: 10, note: "first" }),
    });
    const first = await added.json();
    assert.equal(added.status, 201);
    assert.equal(first.item.ticker, "NOK");
    assert.equal(first.item.lastComposite, 10);
    assert.equal(first.item.previousComposite, null);
    assert.equal(first.item.note, "first");
    assert.ok(first.item.lastRunAt);

    const updated = await fetch(`${url}/api/watchlist`, {
      method: "POST",
      headers: authHeaders(session),
      body: JSON.stringify({ ticker: "NOK", composite: 70, note: "second" }),
    });
    const second = await updated.json();
    assert.equal(second.item.previousComposite, 10);
    assert.equal(second.item.lastComposite, 70);
    assert.equal(second.item.note, "second");

    const bearer = await fetch(`${url}/api/watchlist`, {
      method: "POST",
      headers: authHeaders(session, { bearer: true, csrf: false }),
      body: JSON.stringify({ ticker: "AIFS", composite: 40, note: "via bearer" }),
    });
    assert.equal(bearer.status, 201);

    const listed = await fetch(`${url}/api/watchlist`, { headers: { authorization: `Bearer ${session.token}` } });
    const items = (await listed.json()).items.map((item) => item.ticker);
    assert.deepEqual(items, ["NOK", "AIFS"]);

    const removed = await fetch(`${url}/api/watchlist/AIFS`, {
      method: "DELETE",
      headers: authHeaders(session, { json: false }),
    });
    assert.equal(removed.status, 200);
    const again = await fetch(`${url}/api/watchlist/AIFS`, {
      method: "DELETE",
      headers: authHeaders(session, { json: false }),
    });
    assert.equal(again.status, 404);

    for (let index = 0; index < 19; index += 1) {
      const extra = await fetch(`${url}/api/watchlist`, {
        method: "POST",
        headers: authHeaders(session),
        body: JSON.stringify({ ticker: `T${index}` }),
      });
      assert.equal(extra.status, 201);
    }
    const overflow = await fetch(`${url}/api/watchlist`, {
      method: "POST",
      headers: authHeaders(session),
      body: JSON.stringify({ ticker: "ZZZZ" }),
    });
    assert.equal(overflow.status, 400);
  });
});

test("reanalyze uses the request key, shifts composites, and ignores a production env key", async () => {
  const calls = [];
  const app = createApp({
    env: {
      NODE_ENV: "production",
      ADMIN_EMAIL: "bot@example.com",
      ALPHA_VANTAGE_API_KEY: "ENV_KEY_SHOULD_NOT_LEAK",
    },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return avFetch(url);
    },
  });
  await withServer(app, async ({ url }) => {
    const session = await signUp(url, "bot@example.com");
    await fetch(`${url}/api/watchlist`, {
      method: "POST",
      headers: authHeaders(session),
      body: JSON.stringify({ ticker: "NOK", composite: 10, note: "keep me" }),
    });
    const blocked = await fetch(`${url}/api/watchlist/reanalyze`, {
      method: "POST",
      headers: authHeaders(session),
      body: JSON.stringify({ ticker: "NOK" }),
    });
    const blockedText = await blocked.text();
    assert.equal(blocked.status, 400);
    assert.equal(blockedText.includes("ENV_KEY_SHOULD_NOT_LEAK"), false);
    assert.equal(calls.length, 0);

    const scored = await fetch(`${url}/api/watchlist/reanalyze`, {
      method: "POST",
      headers: { ...authHeaders(session, { bearer: true, csrf: false }), "x-api-key": "client-key" },
      body: JSON.stringify({ all: true }),
    });
    const body = await scored.json();
    assert.equal(scored.status, 200, JSON.stringify(body));
    assert.equal(body.results[0].ok, true);
    assert.equal(body.results[0].composite, 69);
    assert.equal(body.items[0].previousComposite, 10);
    assert.equal(body.items[0].lastComposite, 69);
    assert.equal(body.items[0].note, "keep me");
    assert.equal(JSON.stringify(body).includes("client-key"), false);
    assert.equal(calls.length > 0, true);
    assert.equal(calls.every((url) => url.includes("apikey=client-key")), true);
    assert.equal(calls.some((url) => url.includes("ENV_KEY_SHOULD_NOT_LEAK")), false);
  });
});

test("stripe webhook signature updates the plan and checkout ignores a client price", async () => {
  const calls = [];
  const realStripe = new Stripe(STRIPE_KEY);
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.push({ kind: "checkout", params });
          return { url: "https://checkout.stripe.com/c/pay/cs_test_123" };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          calls.push({ kind: "portal", params });
          return { url: "https://billing.stripe.com/p/session/test_123" };
        },
      },
    },
    webhooks: {
      constructEvent: (body, signature, secret) => realStripe.webhooks.constructEvent(body, signature, secret),
    },
  };
  const app = createApp({
    env: testEnv({
      STRIPE_SECRET_KEY: STRIPE_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICE_ID: "price_123",
      PUBLIC_BASE_URL: "http://127.0.0.1:4721",
    }),
    stripeClient: stripe,
    fetchImpl: async () => jsonResponse({}),
  });
  await withServer(app, async ({ url }) => {
    const session = await signUp(url, "payer@example.com");
    const portalEarly = await fetch(`${url}/api/billing/portal`, {
      method: "POST",
      headers: authHeaders(session),
      body: "{}",
    });
    assert.equal(portalEarly.status, 400);

    const checkout = await fetch(`${url}/api/billing/checkout`, {
      method: "POST",
      headers: authHeaders(session),
      body: JSON.stringify({ price: "price_evil" }),
    });
    const checkoutBody = await checkout.json();
    assert.equal(checkout.status, 200);
    assert.equal(checkoutBody.url, "https://checkout.stripe.com/c/pay/cs_test_123");
    assert.equal(calls[0].params.line_items[0].price, "price_123");
    assert.equal(calls[0].params.client_reference_id, session.user.id);
    assert.equal(calls[0].params.mode, "subscription");
    assert.equal(calls[0].params.success_url, "http://127.0.0.1:4721/?billing=success");

    const bad = signedEvent({ id: "evt_bad", object: "event", type: "ping" });
    const rejected = await fetch(`${url}/api/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: bad.payload,
    });
    assert.equal(rejected.status, 400);

    const activated = signedEvent({
      id: "evt_sub",
      object: "event",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_test123456",
          object: "subscription",
          status: "active",
          customer: "cus_test123456",
          metadata: { userId: session.user.id },
        },
      },
    });
    const accepted = await fetch(`${url}/api/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": activated.header },
      body: activated.payload,
    });
    assert.equal(accepted.status, 200);
    const me = await fetch(`${url}/api/auth/me`, { headers: { cookie: session.cookie } });
    const meBody = await me.json();
    assert.equal(meBody.user.plan, "pro");
    assert.equal(meBody.user.hasBilling, true);
    assert.equal(JSON.stringify(meBody).includes("cus_test123456"), false);

    const portal = await fetch(`${url}/api/billing/portal`, {
      method: "POST",
      headers: authHeaders(session),
      body: "{}",
    });
    assert.equal(portal.status, 200);
    assert.equal(calls[1].params.customer, "cus_test123456");

    const failed = signedEvent({
      id: "evt_fail",
      object: "event",
      type: "invoice.payment_failed",
      data: {
        object: {
          object: "invoice",
          customer: "cus_test123456",
          subscription: "sub_test123456",
        },
      },
    });
    const failResponse = await fetch(`${url}/api/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": failed.header },
      body: failed.payload,
    });
    assert.equal(failResponse.status, 200);
    const after = await fetch(`${url}/api/auth/me`, { headers: { cookie: session.cookie } });
    assert.equal((await after.json()).user.plan, "free");
  });
});

test("checkout and cancel events map onto the user plan", () => {
  const state = {
    users: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        email: "payer@example.com",
        plan: "free",
        role: "user",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      },
    ],
    sessions: [],
    watchlists: {},
  };
  const paid = applyStripeEvent(state, {
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "subscription",
        payment_status: "paid",
        client_reference_id: state.users[0].id,
        customer: "cus_paid123",
        subscription: "sub_paid123",
      },
    },
  });
  assert.equal(paid.applied, true);
  assert.equal(state.users[0].plan, "pro");
  const canceled = applyStripeEvent(state, {
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_paid123",
        status: "canceled",
        customer: "cus_paid123",
        metadata: { userId: state.users[0].id },
      },
    },
  });
  assert.equal(canceled.plan, "free");
  assert.equal(state.users[0].plan, "free");
});

test("signup is rate limited and the password is not in the response", async () => {
  const app = createApp({
    env: testEnv({ RATE_LIMIT_SIGNUP: 2, RATE_LIMIT_LOGIN: 2 }),
    fetchImpl: async () => jsonResponse({}),
  });
  await withServer(app, async ({ url }) => {
    const first = await signUp(url, "one@example.com");
    const second = await signUp(url, "two@example.com");
    assert.equal(first.user.email, "one@example.com");
    assert.equal(second.response.status, 201);
    const third = await fetch(`${url}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "three@example.com", password: PASSWORD }),
    });
    assert.equal(third.status, 429);
    const headers = { "content-type": "application/json" };
    const body = JSON.stringify({ email: "one@example.com", password: PASSWORD });
    const firstLogin = await fetch(`${url}/api/auth/login`, { method: "POST", headers, body });
    const secondLogin = await fetch(`${url}/api/auth/login`, { method: "POST", headers, body });
    const thirdLogin = await fetch(`${url}/api/auth/login`, { method: "POST", headers, body });
    assert.equal(firstLogin.status, 200);
    assert.equal(secondLogin.status, 200);
    assert.equal(thirdLogin.status, 429);
    assert.equal((await thirdLogin.text()).includes(PASSWORD), false);
  });
});

test("file store round-trips accounts without the plaintext password", async () => {
  const dir = await mkdtemp(join(tmpdir(), "si-stocktool-"));
  try {
    const app = createApp({
      env: testEnv({ DATA_DIR: dir, ADMIN_EMAIL: "seed@example.com", ADMIN_PASSWORD: PASSWORD }),
      fetchImpl: async () => jsonResponse({}),
    });
    await withServer(app, async ({ url }) => {
      const health = await fetch(`${url}/api/health`);
      assert.equal(health.status, 200);
    });
    const file = join(dir, "store.json");
    const text = await readFile(file, "utf8");
    assert.equal(text.includes(PASSWORD), false);
    assert.match(text, /seed@example.com/);
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode & 0o077, 0);

    const again = createApp({
      env: testEnv({ DATA_DIR: dir }),
      fetchImpl: async () => jsonResponse({}),
    });
    await withServer(again, async ({ url }) => {
      const login = await fetch(`${url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "seed@example.com", password: PASSWORD }),
      });
      const body = await login.json();
      assert.equal(login.status, 200, JSON.stringify(body));
      assert.equal(body.user.role, "admin");
      assert.equal(body.user.plan, "pro");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
