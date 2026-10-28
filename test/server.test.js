import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { MAX_TICKERS, requestLogLine, scrub } from "../src/http-security.js";
import { createApp } from "../src/server.js";

const SENTINEL = "SENTINEL_KEY_do_not_leak";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function quotePayload(symbol = "IBM") {
  return {
    "Global Quote": {
      "01. symbol": symbol,
      "05. price": "10.00",
      "09. change": "0.10",
      "10. change percent": "1.0%",
      "07. latest trading day": "2026-01-02",
    },
  };
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

async function signUp(url, email, password) {
  const response = await fetch(`${url}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  return { cookie, csrf: body.csrfToken, token: body.token, user: body.user };
}

function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore() {
      console.log = original;
    },
  };
}

test("scrub and request logs omit api keys", () => {
  const scrubbed = scrub({ apiKey: SENTINEL, nested: { note: `key ${SENTINEL}` } }, SENTINEL);
  assert.equal(scrubbed.apiKey, "[redacted]");
  assert.equal(scrubbed.nested.note.includes(SENTINEL), false);
  const line = requestLogLine({ method: "POST", path: "/api/test-connection", body: { apiKey: SENTINEL } }, { statusCode: 200 }, 4);
  assert.equal(JSON.stringify(line).includes(SENTINEL), false);
  assert.equal(line.path, "/api/test-connection");
});

test("health, helmet, and demo book", async () => {
  const app = createApp({ env: { NODE_ENV: "production" }, fetchImpl: async () => jsonResponse({}) });
  await withServer(app, async ({ url }) => {
    const health = await fetch(`${url}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await health.json(), { ok: true, service: "si-stocktool" });
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Portfolio/);
    assert.match(html, /Portefeuille/);
    assert.match(html, /Laatste 3 maanden/);
    assert.doesNotMatch(html, /Portfolio notionals/);
    assert.match(html, /Stock Analyzer/);
    assert.match(html, /Add to watchlist\?/);
    assert.match(html, /Live quotes are the latest prices/);
    assert.equal(html.includes("Sample book"), false);
    const book = await fetch(`${url}/api/demo-book`);
    const body = await book.json();
    assert.equal(body.positions.length, 5);
  });
});

test("production test-connection ignores the env key and query string", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return jsonResponse(quotePayload());
  };
  const app = createApp({
    env: { NODE_ENV: "production", ALPHA_VANTAGE_API_KEY: "env-secret-should-not-be-used" },
    fetchImpl,
  });
  await withServer(app, async ({ url }) => {
    const missing = await fetch(`${url}/api/test-connection?apiKey=${SENTINEL}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missing.status, 400);
    assert.equal(calls.length, 0);
    const text = await missing.text();
    assert.equal(text.includes("env-secret-should-not-be-used"), false);
    assert.equal(text.includes(SENTINEL), false);

    const ok = await fetch(`${url}/api/test-connection`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-key" },
      body: "{}",
    });
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.source, "client");
    assert.equal(JSON.stringify(payload).includes("client-key"), false);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /apikey=client-key/);
    assert.equal(calls[0].includes("env-secret"), false);
  });
});

test("development test-connection can use the local env key without echoing it", async () => {
  const calls = [];
  const app = createApp({
    env: { NODE_ENV: "development", ALPHA_VANTAGE_API_KEY: SENTINEL },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse(quotePayload());
    },
  });
  await withServer(app, async ({ url }) => {
    const response = await fetch(`${url}/api/test-connection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.source, "env");
    assert.equal(JSON.stringify(payload).includes(SENTINEL), false);
    assert.match(calls[0], new RegExp(`apikey=${SENTINEL}`));
  });
});

test("quotes cap and replay do not call upstream", async () => {
  let calls = 0;
  const app = createApp({
    env: { NODE_ENV: "production", ADMIN_EMAIL: "desk-admin@example.com" },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(quotePayload("NOK"));
    },
  });
  await withServer(app, async ({ url }) => {
    const tooMany = await fetch(`${url}/api/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-key" },
      body: JSON.stringify({
        tickers: Array.from({ length: MAX_TICKERS + 1 }, (_, index) => `T${index}`),
      }),
    });
    assert.equal(tooMany.status, 400);
    assert.match(await tooMany.text(), /maximum of 20/);
    assert.equal(calls, 0);

    const one = await fetch(`${url}/api/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-key" },
      body: JSON.stringify({ tickers: ["nok"] }),
    });
    assert.equal(one.status, 200);
    const quoted = await one.json();
    assert.equal(quoted.quotes[0].ticker, "NOK");
    assert.equal(quoted.quotes[0].price, "10.00");
    assert.equal(JSON.stringify(quoted).includes("client-key"), false);
    assert.equal(calls, 1);

    const session = await signUp(url, "desk-admin@example.com", "correct-horse-1");
    const replay = await fetch(`${url}/api/analyze`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify({ ticker: "NOK", replay: true }),
    });
    const scored = await replay.json();
    assert.equal(replay.status, 200);
    assert.equal(scored.mode, "replay");
    assert.equal(scored.pillars.length, 8);
    assert.equal(calls, 1);
  });
});

test("request logs and upstream failures do not contain the api key", async () => {
  const logs = captureLogs();
  const app = createApp({
    env: { NODE_ENV: "production" },
    fetchImpl: async () => {
      throw new Error(`boom ${SENTINEL}`);
    },
  });
  try {
    await withServer(app, async ({ url }) => {
      const response = await fetch(`${url}/api/test-connection`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: SENTINEL }),
      });
      const text = await response.text();
      assert.equal(response.status, 502);
      assert.equal(text.includes(SENTINEL), false);
      const broken = await fetch(`${url}/api/test-connection`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"apiKey":"${SENTINEL}"`,
      });
      assert.equal(broken.status, 400);
      assert.equal((await broken.text()).includes(SENTINEL), false);
    });
  } finally {
    logs.restore();
  }
  const joined = logs.lines.join("\n");
  assert.equal(joined.includes(SENTINEL), false);
  assert.match(joined, /\/api\/test-connection/);
});

test("rate limit is per route", async () => {
  const app = createApp({
    env: { NODE_ENV: "test", RATE_LIMIT_TEST_CONNECTION: 2 },
    fetchImpl: async () => jsonResponse(quotePayload()),
  });
  await withServer(app, async ({ url }) => {
    const headers = { "content-type": "application/json", "x-api-key": "client-key" };
    const first = await fetch(`${url}/api/test-connection`, { method: "POST", headers, body: "{}" });
    const second = await fetch(`${url}/api/test-connection`, { method: "POST", headers, body: "{}" });
    const third = await fetch(`${url}/api/test-connection`, { method: "POST", headers, body: "{}" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
  });
});

test("production CORS stays same-origin unless ALLOWED_ORIGIN is set", async () => {
  const locked = createApp({ env: { NODE_ENV: "production" }, fetchImpl: async () => jsonResponse({}) });
  await withServer(locked, async ({ url }) => {
    const denied = await fetch(`${url}/api/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    const local = await fetch(`${url}/api/health`, { headers: { origin: "http://localhost" } });
    assert.equal(local.headers.get("access-control-allow-origin"), null);
  });

  const opened = createApp({
    env: { NODE_ENV: "production", ALLOWED_ORIGIN: "https://desk.example" },
    fetchImpl: async () => jsonResponse({}),
  });
  await withServer(opened, async ({ url }) => {
    const allowed = await fetch(`${url}/api/health`, { headers: { origin: "https://desk.example" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://desk.example");
  });

  const dev = createApp({ env: { NODE_ENV: "development" }, fetchImpl: async () => jsonResponse({}) });
  await withServer(dev, async ({ url }) => {
    const local = await fetch(`${url}/api/health`, { headers: { origin: "http://127.0.0.1:4721" } });
    assert.equal(local.headers.get("access-control-allow-origin"), "http://127.0.0.1:4721");
  });
});
