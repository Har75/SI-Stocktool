import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import Stripe from "stripe";
import { alphaVantage, quoteFromGlobal, searchMatches, seriesCloses, upstreamProblem } from "./alphavantage.js";
import {
  bcryptCost,
  clearSessionCookie,
  createSession,
  csrfOk,
  dummyPasswordHash,
  ensureAdmin,
  isElevated,
  loadAuth,
  newUser,
  normalizeEmail,
  passwordIssue,
  publicUser,
  rememberSession,
  sessionCookie,
  sessionTtlMs,
} from "./auth.js";
import { applyStripeEvent, checkoutConfig, isStripeRedirect, webhookConfig } from "./billing.js";
import { CASE_STUDIES, SAMPLE_BOOK, SCORE_DISCLAIMER, listCaseStudies } from "./demo-data.js";
import {
  apiLimiter,
  buildCors,
  normalizeTicker,
  normalizeTickers,
  requestLogLine,
  resolveApiKey,
  scrub,
} from "./http-security.js";
import { fundamentalsFromAlphaVantage, scorePillars } from "./pillars.js";
import { FileStore, MemoryStore } from "./store.js";
import {
  addHolding,
  anonymousWeights,
  emptyPortfolio,
  parseHoldingBody,
  portfolioMaterialError,
  presentPortfolio,
  removeHolding,
  updateHolding,
} from "./portfolio.js";
import { MAX_WATCHLIST, applyRescore, cleanText, parseComposite, publicWatchItem, upsertWatchItem } from "./watchlist.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireKey(res, resolved) {
  if (resolved.ok) return true;
  res.status(400).json({
    error: "apiKey is required. Send it in the x-api-key header or JSON body. Production does not use a server env key.",
  });
  return false;
}

function upstreamError(res, apiKey, problem, status = 502) {
  const detail = scrub(String(problem || "Upstream request failed"), apiKey).slice(0, 300);
  res.status(status).json({ error: "Alpha Vantage request failed", detail });
}

function noStore(res) {
  res.set("Cache-Control", "no-store");
}

async function loadFundamentals(fetchImpl, apiKey, ticker) {
  const [overview, income, balance, cashflow] = await Promise.all([
    alphaVantage(fetchImpl, apiKey, { function: "OVERVIEW", symbol: ticker }),
    alphaVantage(fetchImpl, apiKey, { function: "INCOME_STATEMENT", symbol: ticker }),
    alphaVantage(fetchImpl, apiKey, { function: "BALANCE_SHEET", symbol: ticker }),
    alphaVantage(fetchImpl, apiKey, { function: "CASH_FLOW", symbol: ticker }),
  ]);
  return { overview, income, balance, cashflow };
}

function issueSession(res, env, token) {
  const maxAge = Math.floor(sessionTtlMs(env) / 1000);
  res.setHeader("Set-Cookie", sessionCookie(token, env, maxAge));
  noStore(res);
}

export function createApp({
  env = process.env,
  fetchImpl = globalThis.fetch,
  store: storeOverride,
  stripeClient,
} = {}) {
  const store = storeOverride || (env.DATA_DIR ? new FileStore(env.DATA_DIR) : new MemoryStore());
  const ready = Promise.resolve(store.ready).then(() => ensureAdmin(store, env));
  let stripeSingleton = stripeClient || null;

  function getStripe(secretKey) {
    if (stripeSingleton) return stripeSingleton;
    stripeSingleton = new Stripe(secretKey, {
      maxNetworkRetries: 2,
      timeout: 15000,
      appInfo: { name: "si-stocktool" },
    });
    return stripeSingleton;
  }

  const app = express();
  app.disable("x-powered-by");
  if (env.NODE_ENV === "production" || env.TRUST_PROXY === "1") {
    app.set("trust proxy", 1);
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'", "https://checkout.stripe.com", "https://billing.stripe.com"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(cors(buildCors(env)));

  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      console.log(JSON.stringify(requestLogLine(req, res, Date.now() - started)));
    });
    next();
  });

  app.use(async (_req, res, next) => {
    try {
      await ready;
      next();
    } catch {
      console.log(JSON.stringify({ msg: "store unavailable" }));
      res.status(500).json({ error: "Internal error" });
    }
  });

  async function gate(req, res, { pro = false, admin = false, csrf = false } = {}) {
    const auth = await loadAuth(store, req);
    if (!auth) {
      noStore(res);
      res.status(401).json({ error: "Sign in required" });
      return null;
    }
    if (auth.user.blocked) {
      noStore(res);
      res.setHeader("Set-Cookie", clearSessionCookie(env));
      res.status(403).json({ error: "Account blocked" });
      return null;
    }
    if (csrf && !csrfOk(req, auth)) {
      noStore(res);
      res.status(403).json({ error: "CSRF check failed" });
      return null;
    }
    if (admin && auth.user.role !== "admin") {
      noStore(res);
      res.status(403).json({ error: "Admin only" });
      return null;
    }
    if (pro && !isElevated(auth.user)) {
      noStore(res);
      res.status(403).json({ error: "Pro plan required" });
      return null;
    }
    return auth;
  }

  app.get("/favicon.ico", (_req, res) => {
    res.redirect(302, "/favicon.svg");
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "si-stocktool" });
  });

  app.get("/api/demo-book", (_req, res) => {
    res.json(SAMPLE_BOOK);
  });

  app.get("/api/case-studies", (_req, res) => {
    res.json({ studies: listCaseStudies(), disclaimer: SCORE_DISCLAIMER });
  });

  const webhookLimiter = apiLimiter(env, "RATE_LIMIT_WEBHOOK", 120);
  app.post(
    "/api/stripe/webhook",
    webhookLimiter,
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      const config = webhookConfig(env);
      if (!config) {
        res.status(503).json({ error: "Stripe webhook is not configured" });
        return;
      }
      const signature = req.get("stripe-signature") || "";
      if (!signature || !Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "Invalid Stripe signature" });
        return;
      }
      let event;
      try {
        event = getStripe(config.secretKey).webhooks.constructEvent(req.body, signature, config.webhookSecret);
      } catch {
        console.log(JSON.stringify({ msg: "stripe signature rejected" }));
        res.status(400).json({ error: "Invalid Stripe signature" });
        return;
      }
      try {
        const result = await store.update((state) => applyStripeEvent(state, event));
        console.log(JSON.stringify({ msg: "stripe event", type: event.type, applied: Boolean(result?.applied) }));
        res.json({ received: true });
      } catch {
        console.log(JSON.stringify({ msg: "stripe event failed", type: event.type }));
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  app.use(express.json({ limit: "32kb" }));

  const searchLimiter = apiLimiter(env, "RATE_LIMIT_SEARCH", 60);
  const quotesLimiter = apiLimiter(env, "RATE_LIMIT_QUOTES", 30);
  const analyzeLimiter = apiLimiter(env, "RATE_LIMIT_ANALYZE", 10);
  const testLimiter = apiLimiter(env, "RATE_LIMIT_TEST_CONNECTION", 10);
  const signupLimiter = apiLimiter(env, "RATE_LIMIT_SIGNUP", 5);
  const loginLimiter = apiLimiter(env, "RATE_LIMIT_LOGIN", 10);
  const watchlistLimiter = apiLimiter(env, "RATE_LIMIT_WATCHLIST", 30);
  const portfolioLimiter = apiLimiter(env, "RATE_LIMIT_PORTFOLIO", 30);
  const seriesLimiter = apiLimiter(env, "RATE_LIMIT_SERIES", 10);
  const reanalyzeLimiter = apiLimiter(env, "RATE_LIMIT_REANALYZE", 10);
  const adminLimiter = apiLimiter(env, "RATE_LIMIT_ADMIN", 30);
  const billingLimiter = apiLimiter(env, "RATE_LIMIT_BILLING", 10);

  app.post("/api/auth/signup", signupLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const issue = passwordIssue(req.body?.password);
    if (!email || issue) {
      noStore(res);
      res.status(400).json({ error: issue || "Enter a valid email" });
      return;
    }
    const seen = await store.read();
    if (seen.users.some((user) => user.email === email)) {
      noStore(res);
      res.status(409).json({ error: "An account with that email already exists" });
      return;
    }
    const adminEmail = normalizeEmail(env.ADMIN_EMAIL || "");
    const role = email === adminEmail ? "admin" : "user";
    const passwordHash = await bcrypt.hash(req.body.password, bcryptCost(env));
    const created = await store.update((state) => {
      if (state.users.some((user) => user.email === email)) return null;
      const user = newUser({ email, passwordHash, role, plan: role === "admin" ? "pro" : "free" });
      state.users.push(user);
      const opened = createSession(user.id, env);
      rememberSession(state, opened.session);
      return { user, token: opened.token, csrfToken: opened.csrfToken };
    });
    if (!created) {
      noStore(res);
      res.status(409).json({ error: "An account with that email already exists" });
      return;
    }
    issueSession(res, env, created.token);
    res.status(201).json({
      user: publicUser(created.user),
      csrfToken: created.csrfToken,
      token: created.token,
    });
  });

  app.post("/api/auth/login", loginLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const state = await store.read();
    const user = email ? state.users.find((item) => item.email === email) : null;
    const hash = user?.passwordHash || (await dummyPasswordHash(bcryptCost(env)));
    let match = false;
    if (password && Buffer.byteLength(password) <= 72) {
      try {
        match = await bcrypt.compare(password, hash);
      } catch {
        match = false;
      }
    }
    if (!user || !match) {
      noStore(res);
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    if (user.blocked) {
      noStore(res);
      res.status(403).json({ error: "Account blocked" });
      return;
    }
    const opened = createSession(user.id, env);
    const saved = await store.update((draft) => {
      const current = draft.users.find((item) => item.id === user.id);
      if (!current || current.blocked) return null;
      rememberSession(draft, opened.session);
      return current;
    });
    if (!saved) {
      noStore(res);
      res.status(403).json({ error: "Account blocked" });
      return;
    }
    issueSession(res, env, opened.token);
    res.json({ user: publicUser(saved), csrfToken: opened.csrfToken, token: opened.token });
  });

  app.post("/api/auth/logout", loginLimiter, async (req, res) => {
    const auth = await loadAuth(store, req);
    if (auth && !csrfOk(req, auth)) {
      noStore(res);
      res.status(403).json({ error: "CSRF check failed" });
      return;
    }
    if (auth) {
      await store.update((state) => {
        state.sessions = state.sessions.filter((session) => session.id !== auth.session.id);
      });
    }
    res.setHeader("Set-Cookie", clearSessionCookie(env));
    noStore(res);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", async (req, res) => {
    noStore(res);
    const auth = await loadAuth(store, req);
    if (!auth) {
      res.json({ user: null });
      return;
    }
    res.json({ user: publicUser(auth.user), csrfToken: auth.session.csrfToken });
  });

  app.post("/api/billing/checkout", billingLimiter, async (req, res) => {
    const auth = await gate(req, res, { csrf: true });
    if (!auth) return;
    const config = checkoutConfig(env);
    if (!config) {
      res.status(503).json({ error: "Stripe Checkout is not configured" });
      return;
    }
    try {
      const session = await getStripe(config.secretKey).checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: config.price, quantity: 1 }],
        success_url: `${config.base}/?billing=success`,
        cancel_url: `${config.base}/?billing=cancel`,
        client_reference_id: auth.user.id,
        customer: auth.user.stripeCustomerId || undefined,
        customer_email: auth.user.stripeCustomerId ? undefined : auth.user.email,
        metadata: { userId: auth.user.id },
        subscription_data: { metadata: { userId: auth.user.id } },
      });
      if (!isStripeRedirect(session.url)) {
        console.log(JSON.stringify({ msg: "stripe checkout failed" }));
        res.status(502).json({ error: "Stripe checkout failed" });
        return;
      }
      noStore(res);
      res.json({ url: session.url });
    } catch {
      console.log(JSON.stringify({ msg: "stripe checkout failed" }));
      res.status(502).json({ error: "Stripe checkout failed" });
    }
  });

  app.post("/api/billing/portal", billingLimiter, async (req, res) => {
    const auth = await gate(req, res, { csrf: true });
    if (!auth) return;
    const config = checkoutConfig(env);
    if (!config) {
      res.status(503).json({ error: "Stripe billing portal is not configured" });
      return;
    }
    if (!/^cus_[A-Za-z0-9]+$/.test(auth.user.stripeCustomerId || "")) {
      res.status(400).json({ error: "No Stripe customer yet. Subscribe first." });
      return;
    }
    try {
      const portal = await getStripe(config.secretKey).billingPortal.sessions.create({
        customer: auth.user.stripeCustomerId,
        return_url: `${config.base}/`,
      });
      if (!isStripeRedirect(portal.url)) {
        console.log(JSON.stringify({ msg: "stripe portal failed" }));
        res.status(502).json({ error: "Stripe billing portal failed" });
        return;
      }
      noStore(res);
      res.json({ url: portal.url });
    } catch {
      console.log(JSON.stringify({ msg: "stripe portal failed" }));
      res.status(502).json({ error: "Stripe billing portal failed" });
    }
  });

  app.get("/api/admin/users", adminLimiter, async (req, res) => {
    const auth = await gate(req, res, { admin: true });
    if (!auth) return;
    const state = await store.read();
    noStore(res);
    res.json({ users: state.users.map((user) => publicUser(user, { admin: true })) });
  });

  app.post("/api/admin/users/:id", adminLimiter, async (req, res) => {
    const auth = await gate(req, res, { admin: true, csrf: true });
    if (!auth) return;
    const id = USER_ID.test(String(req.params.id || "")) ? String(req.params.id) : "";
    if (!id) {
      res.status(400).json({ error: "user id is invalid" });
      return;
    }
    const plan = req.body?.plan;
    const blocked = req.body?.blocked;
    if (plan != null && plan !== "free" && plan !== "pro") {
      res.status(400).json({ error: "plan must be free or pro" });
      return;
    }
    if (blocked != null && typeof blocked !== "boolean") {
      res.status(400).json({ error: "blocked must be a boolean" });
      return;
    }
    if (plan == null && blocked == null) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    if (blocked === true && id === auth.user.id) {
      res.status(400).json({ error: "You cannot block your own account" });
      return;
    }
    const updated = await store.update((state) => {
      const user = state.users.find((item) => item.id === id);
      if (!user) return null;
      if (plan === "free" || plan === "pro") user.plan = plan;
      if (typeof blocked === "boolean") {
        user.blocked = blocked;
        if (blocked) state.sessions = state.sessions.filter((session) => session.userId !== user.id);
      }
      return publicUser(user, { admin: true });
    });
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    noStore(res);
    res.json({ user: updated });
  });

  app.get("/api/search", searchLimiter, async (req, res) => {
    const keywords = String(req.query.keywords || "").trim();
    if (!keywords || keywords.length > 40) {
      res.status(400).json({ error: "keywords is required (40 characters max)" });
      return;
    }
    const resolved = resolveApiKey(req, env);
    if (!requireKey(res, resolved)) return;
    try {
      const payload = await alphaVantage(fetchImpl, resolved.key, {
        function: "SYMBOL_SEARCH",
        keywords,
      });
      const problem = upstreamProblem(payload);
      if (problem && !payload.bestMatches) {
        upstreamError(res, resolved.key, problem, payload.Note ? 429 : 502);
        return;
      }
      res.json({ matches: searchMatches(payload) });
    } catch {
      console.log(JSON.stringify({ msg: "upstream failed", path: req.path }));
      res.status(502).json({ error: "Upstream request failed" });
    }
  });

  app.post("/api/quotes", quotesLimiter, async (req, res) => {
    const normalized = normalizeTickers(req.body?.tickers);
    if (normalized.error) {
      res.status(400).json({ error: normalized.error });
      return;
    }
    const resolved = resolveApiKey(req, env);
    if (!requireKey(res, resolved)) return;
    const quotes = [];
    for (const ticker of normalized.tickers) {
      try {
        const payload = await alphaVantage(fetchImpl, resolved.key, {
          function: "GLOBAL_QUOTE",
          symbol: ticker,
        });
        const problem = upstreamProblem(payload);
        const quote = quoteFromGlobal(payload, ticker);
        if (!quote) {
          quotes.push({
            ticker,
            error: scrub(problem || "No quote returned", resolved.key).slice(0, 300),
          });
        } else {
          quotes.push(quote);
        }
      } catch {
        console.log(JSON.stringify({ msg: "upstream failed", path: req.path }));
        quotes.push({ ticker, error: "Upstream request failed" });
      }
    }
    res.json({ quotes });
  });

  app.post("/api/analyze", analyzeLimiter, async (req, res) => {
    const auth = await gate(req, res, { pro: true, csrf: true });
    if (!auth) return;
    const ticker = normalizeTicker(req.body?.ticker);
    if (!ticker) {
      res.status(400).json({ error: "ticker is required" });
      return;
    }

    if (req.body?.replay === true) {
      const study = CASE_STUDIES[ticker];
      if (!study) {
        res.status(404).json({ error: "No sample case study for that ticker" });
        return;
      }
      noStore(res);
      res.json({
        mode: "replay",
        ticker,
        label: study.label,
        disclaimer: `${study.disclaimer} ${SCORE_DISCLAIMER}`,
        ...scorePillars(study.fundamentals),
      });
      return;
    }

    const resolved = resolveApiKey(req, env);
    if (!requireKey(res, resolved)) return;
    try {
      const loaded = await loadFundamentals(fetchImpl, resolved.key, ticker);
      const problem = upstreamProblem(loaded.overview);
      if (problem && !loaded.overview.Symbol) {
        upstreamError(res, resolved.key, problem, loaded.overview.Note ? 429 : 502);
        return;
      }
      const fundamentals = fundamentalsFromAlphaVantage({
        overview: loaded.overview,
        income: loaded.income,
        balance: loaded.balance,
        cash: loaded.cashflow,
      });
      noStore(res);
      res.json({
        mode: "live",
        ticker,
        label: fundamentals.name || ticker,
        disclaimer: SCORE_DISCLAIMER,
        ...scorePillars(fundamentals),
      });
    } catch {
      console.log(JSON.stringify({ msg: "upstream failed", path: req.path }));
      res.status(502).json({ error: "Upstream request failed" });
    }
  });

  function rejectHolding(res, result) {
    noStore(res);
    res.status(result.status || 400).json({ error: result.error });
  }

  app.get("/api/portfolio/weights", portfolioLimiter, async (req, res) => {
    const auth = await gate(req, res);
    if (!auth) return;
    const state = await store.read();
    noStore(res);
    res.json(anonymousWeights(state.portfolios[auth.user.id] || emptyPortfolio()));
  });

  app.get("/api/portfolio", portfolioLimiter, async (req, res) => {
    const auth = await gate(req, res);
    if (!auth) return;
    const state = await store.read();
    noStore(res);
    res.json(presentPortfolio(state.portfolios[auth.user.id] || emptyPortfolio()));
  });

  app.post("/api/portfolio", portfolioLimiter, async (req, res) => {
    const auth = await gate(req, res, { csrf: true });
    if (!auth) return;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const parsed = parseHoldingBody(body);
    if (parsed.error) {
      rejectHolding(res, parsed);
      return;
    }
    const saved = await store.update((state) => {
      const current = state.portfolios[auth.user.id] || emptyPortfolio();
      const result = addHolding(current, parsed.input);
      if (result.error) return result;
      state.portfolios[auth.user.id] = result.record;
      return presentPortfolio(result.record, result.item);
    });
    if (saved.error) {
      rejectHolding(res, saved);
      return;
    }
    noStore(res);
    res.status(201).json(saved);
  });

  app.patch("/api/portfolio/:ticker", portfolioLimiter, async (req, res) => {
    const auth = await gate(req, res, { csrf: true });
    if (!auth) return;
    const ticker = normalizeTicker(req.params.ticker);
    if (!ticker) {
      res.status(400).json({ error: "ticker is required" });
      return;
    }
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const parsed = parseHoldingBody(body, ticker);
    if (parsed.error) {
      rejectHolding(res, parsed);
      return;
    }
    const saved = await store.update((state) => {
      const current = state.portfolios[auth.user.id] || emptyPortfolio();
      const result = updateHolding(current, ticker, parsed.input);
      if (result.error) return result;
      state.portfolios[auth.user.id] = result.record;
      return presentPortfolio(result.record, result.item);
    });
    if (saved.error) {
      rejectHolding(res, saved);
      return;
    }
    noStore(res);
    res.json(saved);
  });

  app.delete("/api/portfolio/:ticker", portfolioLimiter, async (req, res) => {
    const auth = await gate(req, res, { csrf: true });
    if (!auth) return;
    const ticker = normalizeTicker(req.params.ticker);
    if (!ticker) {
      res.status(400).json({ error: "ticker is required" });
      return;
    }
    const saved = await store.update((state) => {
      const current = state.portfolios[auth.user.id] || emptyPortfolio();
      const result = removeHolding(current, ticker);
      if (result.error) return result;
      state.portfolios[auth.user.id] = result.record;
      return presentPortfolio(result.record);
    });
    if (saved.error) {
      rejectHolding(res, saved);
      return;
    }
    noStore(res);
    res.json(saved);
  });

  app.post("/api/series", seriesLimiter, async (req, res) => {
    const auth = await gate(req, res, { pro: true, csrf: true });
    if (!auth) return;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const material = portfolioMaterialError(body);
    if (material) {
      rejectHolding(res, material);
      return;
    }
    const span = body.span === "intraday" || body.span === "daily" ? body.span : "";
    if (!span) {
      res.status(400).json({ error: "span must be intraday or daily" });
      return;
    }
    const normalized = normalizeTickers(body.tickers);
    if (normalized.error) {
      res.status(400).json({ error: normalized.error });
      return;
    }
    if (normalized.tickers.length > 10) {
      res.status(400).json({ error: "series accepts at most 10 tickers" });
      return;
    }
    const resolved = resolveApiKey(req, env);
    if (!requireKey(res, resolved)) return;
    const series = [];
    const seriesKey = span === "daily" ? "Time Series (Daily)" : "Time Series (15min)";
    for (const ticker of normalized.tickers) {
      try {
        const params =
          span === "daily"
            ? { function: "TIME_SERIES_DAILY", symbol: ticker, outputsize: "full" }
            : { function: "TIME_SERIES_INTRADAY", symbol: ticker, interval: "15min", outputsize: "compact" };
        const payload = await alphaVantage(fetchImpl, resolved.key, params);
        const points = seriesCloses(payload, seriesKey, span === "daily" ? 160 : 200);
        if (!points.length) {
          const problem = upstreamProblem(payload);
          series.push({
            ticker,
            error: scrub(problem || "No series returned", resolved.key).slice(0, 300),
          });
        } else {
          series.push({ ticker, points });
        }
      } catch {
        console.log(JSON.stringify({ msg: "upstream failed", path: req.path }));
        series.push({ ticker, error: "Upstream request failed" });
      }
    }
    noStore(res);
    res.json({ span, series });
  });

  app.get("/api/watchlist", watchlistLimiter, async (req, res) => {
    const auth = await gate(req, res, { pro: true });
    if (!auth) return;
    const state = await store.read();
    const items = (state.watchlists[auth.user.id] || []).slice(0, MAX_WATCHLIST).map(publicWatchItem);
    noStore(res);
    res.json({ items });
  });

  app.post("/api/watchlist", watchlistLimiter, async (req, res) => {
    const auth = await gate(req, res, { pro: true, csrf: true });
    if (!auth) return;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const ticker = normalizeTicker(body.ticker);
    if (!ticker) {
      res.status(400).json({ error: "ticker is required" });
      return;
    }
    const input = { ticker };
    if (Object.prototype.hasOwnProperty.call(body, "label")) {
      const label = cleanText(body.label, 80);
      if (label == null) {
        res.status(400).json({ error: "label is invalid" });
        return;
      }
      if (label) input.label = label;
    }
    if (Object.prototype.hasOwnProperty.call(body, "note")) {
      const note = cleanText(body.note, 280);
      if (note == null) {
        res.status(400).json({ error: "note is invalid" });
        return;
      }
      input.note = note;
    }
    if (Object.prototype.hasOwnProperty.call(body, "composite")) {
      const composite = parseComposite(body.composite);
      if (!composite.ok) {
        res.status(400).json({ error: "composite must be an integer from 0 to 100" });
        return;
      }
      input.composite = composite.value;
    }
    const nowIso = new Date().toISOString();
    const saved = await store.update((state) => {
      const current = state.watchlists[auth.user.id] || [];
      const result = upsertWatchItem(current, input, nowIso);
      if (result.error) return result;
      state.watchlists[auth.user.id] = result.items;
      return { item: publicWatchItem(result.item) };
    });
    if (saved.error) {
      res.status(400).json({ error: saved.error });
      return;
    }
    noStore(res);
    res.status(201).json(saved);
  });

  app.delete("/api/watchlist/:ticker", watchlistLimiter, async (req, res) => {
    const auth = await gate(req, res, { pro: true, csrf: true });
    if (!auth) return;
    const ticker = normalizeTicker(req.params.ticker);
    if (!ticker) {
      res.status(400).json({ error: "ticker is required" });
      return;
    }
    const removed = await store.update((state) => {
      const current = state.watchlists[auth.user.id] || [];
      if (!current.some((item) => item.ticker === ticker)) return false;
      state.watchlists[auth.user.id] = current.filter((item) => item.ticker !== ticker);
      return true;
    });
    if (!removed) {
      res.status(404).json({ error: "Ticker is not on the watchlist" });
      return;
    }
    noStore(res);
    res.json({ ok: true });
  });

  app.post("/api/watchlist/reanalyze", reanalyzeLimiter, async (req, res) => {
    const auth = await gate(req, res, { pro: true, csrf: true });
    if (!auth) return;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const material = portfolioMaterialError(body);
    if (material) {
      rejectHolding(res, material);
      return;
    }
    if (body.all != null && body.all !== true && body.all !== false) {
      res.status(400).json({ error: "all must be a boolean" });
      return;
    }
    const all = body.all === true;
    const ticker = body.ticker == null || body.ticker === "" ? "" : normalizeTicker(body.ticker);
    if (body.ticker != null && body.ticker !== "" && !ticker) {
      res.status(400).json({ error: "ticker is required" });
      return;
    }
    if (all && ticker) {
      res.status(400).json({ error: "Send either ticker or all, not both" });
      return;
    }
    if (!all && !ticker) {
      res.status(400).json({ error: "ticker or all is required" });
      return;
    }
    const state = await store.read();
    const items = (state.watchlists[auth.user.id] || []).slice(0, MAX_WATCHLIST);
    if (!all && !items.some((item) => item.ticker === ticker)) {
      res.status(404).json({ error: "Ticker is not on the watchlist" });
      return;
    }
    const targets = all ? items : items.filter((item) => item.ticker === ticker);
    if (targets.length === 0) {
      noStore(res);
      res.json({ items: items.map(publicWatchItem), results: [] });
      return;
    }
    const resolved = resolveApiKey(req, env);
    if (!requireKey(res, resolved)) return;

    const scores = [];
    const results = [];
    for (const item of targets) {
      try {
        const loaded = await loadFundamentals(fetchImpl, resolved.key, item.ticker);
        const problem = upstreamProblem(loaded.overview);
        if (problem && !loaded.overview.Symbol) {
          results.push({
            ticker: item.ticker,
            ok: false,
            error: scrub(String(problem), resolved.key).slice(0, 300),
          });
          continue;
        }
        const fundamentals = fundamentalsFromAlphaVantage({
          overview: loaded.overview,
          income: loaded.income,
          balance: loaded.balance,
          cash: loaded.cashflow,
        });
        const scored = scorePillars(fundamentals);
        const rawName = String(fundamentals.name || item.label || item.ticker).slice(0, 80);
        const label = cleanText(rawName, 80) || item.ticker;
        const nowIso = new Date().toISOString();
        scores.push({ ticker: item.ticker, composite: scored.composite, label, nowIso });
        results.push({ ticker: item.ticker, ok: true, composite: scored.composite });
      } catch {
        console.log(JSON.stringify({ msg: "upstream failed", path: req.path }));
        results.push({ ticker: item.ticker, ok: false, error: "Upstream request failed" });
      }
    }

    const saved = await store.update((draft) => {
      const latest = (draft.watchlists[auth.user.id] || []).slice(0, MAX_WATCHLIST);
      const byTicker = new Map(scores.map((row) => [row.ticker, row]));
      const next = latest.map((item) => {
        const row = byTicker.get(item.ticker);
        return row ? applyRescore(item, row) : item;
      });
      draft.watchlists[auth.user.id] = next;
      return next.map(publicWatchItem);
    });
    noStore(res);
    res.json({ items: saved, results });
  });

  app.post("/api/test-connection", testLimiter, async (req, res) => {
    const resolved = resolveApiKey(req, env);
    if (!requireKey(res, resolved)) return;
    try {
      const payload = await alphaVantage(fetchImpl, resolved.key, {
        function: "GLOBAL_QUOTE",
        symbol: "IBM",
      });
      const quote = quoteFromGlobal(payload, "IBM");
      if (!quote) {
        const problem = upstreamProblem(payload) || "Key was not accepted";
        upstreamError(res, resolved.key, problem, payload?.Note ? 429 : 502);
        return;
      }
      res.json({
        ok: true,
        source: resolved.source,
        message: "Alpha Vantage accepted the key.",
      });
    } catch {
      console.log(JSON.stringify({ msg: "upstream failed", path: req.path }));
      res.status(502).json({ error: "Upstream request failed" });
    }
  });

  app.use(express.static(publicDir, { index: "index.html", dotfiles: "ignore" }));

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
    console.log(JSON.stringify({ msg: "request failed", path: req.path, status: 500 }));
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}

export function start(env = process.env) {
  const port = Number(env.PORT) || 4721;
  const merged = { ...env };
  if (!merged.DATA_DIR) merged.DATA_DIR = join(process.cwd(), "data");
  const app = createApp({ env: merged });
  const server = createServer(app);
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ msg: "listening", port, nodeEnv: merged.NODE_ENV || "development" }));
  });
  return server;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry === import.meta.url) {
  start();
}
