import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seriesCloses } from "../src/alphavantage.js";
import {
  KDF_ITERATIONS as SERVER_ITERATIONS,
  addHolding,
  anonymousWeights,
  emptyPortfolio,
  parseHoldingBody,
  presentPortfolio,
} from "../src/portfolio.js";
import { createApp } from "../src/server.js";
import { FileStore, MemoryStore } from "../src/store.js";
import { buildSeries, RANGE_ORDER } from "../public/portfolio-chart.js";
import {
  KDF_ITERATIONS as CLIENT_ITERATIONS,
  createKdf,
  decryptQuantity,
  derivePortfolioKey,
  encryptQuantity,
} from "../public/portfolio-crypto.js";

const PASSWORD = "correct-horse-1";
const PIN = "portfolio-pin-1";
const QUANTITY = 7.25;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function testEnv(extra = {}) {
  return { NODE_ENV: "test", BCRYPT_COST: "4", RATE_LIMIT_PORTFOLIO: "500", RATE_LIMIT_SERIES: "50", ...extra };
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

async function signUp(url, email) {
  const response = await fetch(`${url}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  return { cookie, csrf: body.csrfToken, token: body.token, user: body.user };
}

function authHeaders(session, { bearer = false, csrf = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${session.token}`;
  else headers.cookie = session.cookie;
  if (csrf && !bearer) headers["x-csrf-token"] = session.csrf;
  return headers;
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

async function cipherFor(quantity, kdf = createKdf(), pin = PIN) {
  const key = await derivePortfolioKey(pin, kdf);
  return { kdf, cipher: await encryptQuantity(key, quantity), key };
}

test("client and server agree on the KDF and the chart periods", () => {
  assert.equal(CLIENT_ITERATIONS, SERVER_ITERATIONS);
  assert.deepEqual(RANGE_ORDER, ["day", "week", "month", "quarter", "half"]);
});

test("plaintext quantities are rejected and percent weights stay under the cap", () => {
  const leaked = parseHoldingBody({ ticker: "nok", mode: "quantity", quantity: QUANTITY });
  assert.equal(leaked.status, 400);
  assert.equal(JSON.stringify(leaked).includes(String(QUANTITY)), false);

  const first = addHolding(emptyPortfolio(), { ticker: "NOK", mode: "percent", percent: 60 });
  assert.equal(first.record.holdings[0].percent, 60);
  const over = addHolding(first.record, { ticker: "AIFS", mode: "percent", percent: 50 });
  assert.equal(over.status, 400);
  assert.equal(first.record.holdings.length, 1);
  const under = addHolding(first.record, { ticker: "AIFS", mode: "percent", percent: 40 });
  assert.equal(under.record.holdings.length, 2);
  const view = presentPortfolio(under.record);
  assert.equal(view.allocation.status, "complete");
  assert.equal(view.allocation.percentSum, 100);
  assert.equal(JSON.stringify(view).includes('"quantity":'), false);
});

test("encrypted quantity round-trips only with the PIN", async () => {
  const { kdf, cipher, key } = await cipherFor(QUANTITY);
  assert.equal(JSON.stringify(cipher).includes(String(QUANTITY)), false);
  assert.equal(await decryptQuantity(key, cipher), QUANTITY);
  const wrong = await derivePortfolioKey("other-pin-value", kdf);
  await assert.rejects(() => decryptQuantity(wrong, cipher));

  const parsed = parseHoldingBody({ ticker: "NOK", mode: "quantity", quantityCipher: cipher, kdf });
  assert.equal(parsed.error, undefined);
  const saved = addHolding(emptyPortfolio(), parsed.input);
  assert.equal(saved.record.holdings[0].quantityCipher.ct, cipher.ct);
  assert.equal(Object.hasOwn(saved.record.holdings[0], "quantity"), false);
  const weights = anonymousWeights(saved.record);
  assert.deepEqual(weights.weights, []);
  assert.equal(JSON.stringify(weights).includes("quantityCipher"), false);
  assert.equal(JSON.stringify(weights).includes(cipher.ct), false);
});

test("percent index starts at 100 and quantity value is shares times price", () => {
  const daily = {
    AAA: [
      { t: "2026-01-01", close: 10 },
      { t: "2026-06-01", close: 20 },
      { t: "2026-09-01", close: 10 },
      { t: "2026-10-01", close: 30 },
    ],
    BBB: [
      { t: "2026-06-01", close: 8 },
      { t: "2026-09-01", close: 8 },
      { t: "2026-10-01", close: 8 },
    ],
  };
  const half = buildSeries({
    holdings: [
      { ticker: "AAA", mode: "percent", percent: 50 },
      { ticker: "BBB", mode: "percent", percent: 50 },
    ],
    daily,
    range: "half",
  });
  assert.equal(half.mode, "index");
  assert.equal(half.points[0].v, 100);
  assert.equal(half.points[0].t, "2026-06-01");
  assert.equal(half.points.at(-1).v, 125);
  assert.match(half.caption, /100/);
  assert.match(half.caption, /geen bedrag/i);

  const quarter = buildSeries({
    holdings: [{ ticker: "AAA", mode: "percent", percent: 100 }],
    daily,
    range: "quarter",
  });
  assert.equal(quarter.points.some((point) => point.t === "2026-06-01"), false);
  assert.equal(quarter.points[0].t, "2026-09-01");

  const value = buildSeries({
    holdings: [{ ticker: "AAA", mode: "quantity", quantity: 2 }],
    daily,
    range: "quarter",
  });
  assert.equal(value.mode, "value");
  assert.equal(value.points[0].v, 20);
  assert.equal(value.points.at(-1).v, 60);
  assert.doesNotMatch(value.caption, /€|EUR/);
});

test("series parser keeps closes and drops anything else", () => {
  const points = seriesCloses(
    {
      "Time Series (Daily)": {
        "2026-10-02": { "4. close": "4" },
        "2026-10-01": { "4. close": "3" },
        bad: { "4. close": "9" },
      },
    },
    "Time Series (Daily)",
    10,
  );
  assert.deepEqual(points, [
    { t: "2026-10-01", close: 3 },
    { t: "2026-10-02", close: 4 },
  ]);
});

test("portfolio API stores ciphertext, isolates users, and keeps weights anonymous", async () => {
  const store = new MemoryStore();
  const logs = captureLogs();
  const app = createApp({
    env: testEnv({ ADMIN_EMAIL: "pro@example.com" }),
    store,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("TIME_SERIES_INTRADAY")) {
        return jsonResponse({
          "Time Series (15min)": { "2026-10-27 15:45:00": { "4. close": "11" } },
        });
      }
      if (href.includes("TIME_SERIES_DAILY")) {
        return jsonResponse({
          "Time Series (Daily)": {
            "2026-10-01": { "4. close": "10" },
            "2026-10-20": { "4. close": "12" },
          },
        });
      }
      return jsonResponse({});
    },
  });
  try {
    await withServer(app, async ({ url }) => {
      const free = await signUp(url, "free@example.com");
      assert.equal(free.user.plan, "free");
      const denied = await fetch(`${url}/api/series`, {
        method: "POST",
        headers: authHeaders(free),
        body: JSON.stringify({ tickers: ["NOK"], span: "daily" }),
      });
      assert.equal(denied.status, 403);

      const missing = await fetch(`${url}/api/portfolio`);
      assert.equal(missing.status, 401);
      const noCsrf = await fetch(`${url}/api/portfolio`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: free.cookie },
        body: JSON.stringify({ ticker: "NOK", mode: "percent", percent: 25 }),
      });
      assert.equal(noCsrf.status, 403);

      const plain = await fetch(`${url}/api/portfolio`, {
        method: "POST",
        headers: authHeaders(free),
        body: JSON.stringify({ ticker: "NOK", mode: "quantity", quantity: QUANTITY, pin: PIN }),
      });
      const plainBody = await plain.json();
      assert.equal(plain.status, 400);
      assert.equal(JSON.stringify(plainBody).includes(String(QUANTITY)), false);
      assert.equal(JSON.stringify(plainBody).includes(PIN), false);

      const added = await fetch(`${url}/api/portfolio`, {
        method: "POST",
        headers: authHeaders(free),
        body: JSON.stringify({ ticker: "nok", mode: "percent", percent: 60, label: "Nokia" }),
      });
      const addedBody = await added.json();
      assert.equal(added.status, 201);
      assert.equal(addedBody.holding.ticker, "NOK");
      assert.equal(addedBody.allocation.status, "under");

      const tooMuch = await fetch(`${url}/api/portfolio`, {
        method: "POST",
        headers: authHeaders(free),
        body: JSON.stringify({ ticker: "AIFS", mode: "percent", percent: 50 }),
      });
      assert.equal(tooMuch.status, 400);
      const fit = await fetch(`${url}/api/portfolio`, {
        method: "POST",
        headers: authHeaders(free),
        body: JSON.stringify({ ticker: "AIFS", mode: "percent", percent: 40 }),
      });
      assert.equal(fit.status, 201);

      const { kdf, cipher } = await cipherFor(QUANTITY);
      const encrypted = await fetch(`${url}/api/portfolio`, {
        method: "POST",
        headers: authHeaders(free),
        body: JSON.stringify({ ticker: "QOMP", mode: "quantity", quantityCipher: cipher, kdf, label: "Sample" }),
      });
      const encryptedBody = await encrypted.json();
      assert.equal(encrypted.status, 201, JSON.stringify(encryptedBody));
      assert.equal(encryptedBody.holding.quantityCipher.ct, cipher.ct);
      assert.equal(encryptedBody.holding.percent, null);
      assert.equal(JSON.stringify(encryptedBody).includes('"quantity":'), false);
      assert.equal(JSON.stringify(encryptedBody).includes(String(QUANTITY)), false);
      assert.equal(JSON.stringify(encryptedBody).includes(PIN), false);

      const listed = await fetch(`${url}/api/portfolio`, { headers: { cookie: free.cookie } });
      const listedBody = await listed.json();
      assert.deepEqual(
        listedBody.holdings.map((item) => item.ticker),
        ["NOK", "AIFS", "QOMP"],
      );
      const key = await derivePortfolioKey(PIN, listedBody.kdf);
      const opened = await decryptQuantity(key, listedBody.holdings.find((item) => item.ticker === "QOMP").quantityCipher);
      assert.equal(opened, QUANTITY);

      const weights = await fetch(`${url}/api/portfolio/weights`, {
        headers: { authorization: `Bearer ${free.token}` },
      });
      const weightBody = await weights.json();
      assert.equal(weights.status, 200);
      assert.deepEqual(weightBody.weights, [
        { ticker: "NOK", weight: 60 },
        { ticker: "AIFS", weight: 40 },
      ]);
      assert.equal(JSON.stringify(weightBody).includes("quantity"), false);
      assert.equal(JSON.stringify(weightBody).includes(cipher.ct), false);

      const other = await signUp(url, "other@example.com");
      const otherList = await fetch(`${url}/api/portfolio`, { headers: { cookie: other.cookie } });
      assert.deepEqual((await otherList.json()).holdings, []);

      const edited = await fetch(`${url}/api/portfolio/AIFS`, {
        method: "PATCH",
        headers: authHeaders(free),
        body: JSON.stringify({ mode: "percent", percent: 30 }),
      });
      assert.equal((await edited.json()).allocation.status, "under");
      const removed = await fetch(`${url}/api/portfolio/NOK`, {
        method: "DELETE",
        headers: authHeaders(free, { csrf: true }),
      });
      assert.equal(removed.status, 200);

      const pro = await signUp(url, "pro@example.com");
      assert.equal(pro.user.plan, "pro");
      const blockedBot = await fetch(`${url}/api/watchlist/reanalyze`, {
        method: "POST",
        headers: authHeaders(pro),
        body: JSON.stringify({ ticker: "NOK", quantity: QUANTITY, quantityCipher: cipher }),
      });
      const blockedBody = await blockedBot.json();
      assert.equal(blockedBot.status, 400);
      assert.equal(JSON.stringify(blockedBody).includes(String(QUANTITY)), false);

      const series = await fetch(`${url}/api/series`, {
        method: "POST",
        headers: { ...authHeaders(pro), "x-api-key": "client-key" },
        body: JSON.stringify({ tickers: ["NOK"], span: "daily" }),
      });
      const seriesBody = await series.json();
      assert.equal(series.status, 200, JSON.stringify(seriesBody));
      assert.equal(seriesBody.series[0].points.at(-1).close, 12);
      assert.equal(JSON.stringify(seriesBody).includes(String(QUANTITY)), false);

      const state = await store.read();
      const dumped = JSON.stringify(state);
      assert.equal(dumped.includes(String(QUANTITY)), false);
      assert.equal(dumped.includes(PIN), false);
      assert.equal(dumped.includes('"quantity":'), false);
      assert.equal(dumped.includes(PASSWORD), false);
    });
  } finally {
    logs.restore();
  }
  const logged = logs.lines.join("\n");
  assert.equal(logged.includes(String(QUANTITY)), false);
  assert.equal(logged.includes(PIN), false);
  assert.equal(logged.includes(PASSWORD), false);
});

test("file store drops a plaintext quantity and keeps ciphertext fields only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "si-portfolio-"));
  try {
    const userId = "11111111-1111-4111-8111-111111111111";
    await writeFile(
      join(dir, "store.json"),
      JSON.stringify({
        users: [],
        sessions: [],
        watchlists: { ["__proto__"]: [{ ticker: "EVIL" }] },
        portfolios: {
          "not-a-user": { kdf: null, holdings: [{ ticker: "NOK", mode: "percent", percent: 10 }] },
          [userId]: {
            kdf: null,
            holdings: [{ ticker: "NOK", label: "Nokia", mode: "quantity", quantity: QUANTITY, quantityCipher: null }],
          },
        },
      }),
    );
    const store = new FileStore(dir);
    await store.ready;
    const state = await store.read();
    assert.equal(state.portfolios["not-a-user"], undefined);
    assert.equal(state.watchlists.__proto__, undefined);
    const dumped = JSON.stringify(state.portfolios[userId]);
    assert.equal(dumped.includes(String(QUANTITY)), false);
    assert.equal(dumped.includes('"quantity":'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
