import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { alphaVantage, quoteFromGlobal, searchMatches, upstreamProblem } from "./alphavantage.js";
import { CASE_STUDIES, SAMPLE_BOOK, SCORE_DISCLAIMER, listCaseStudies } from "./demo-data.js";
import {
  apiLimiter,
  buildCors,
  normalizeTickers,
  requestLogLine,
  resolveApiKey,
  scrub,
} from "./http-security.js";
import { fundamentalsFromAlphaVantage, scorePillars } from "./pillars.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

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

async function loadFundamentals(fetchImpl, apiKey, ticker) {
  const [overview, income, balance, cashflow] = await Promise.all([
    alphaVantage(fetchImpl, apiKey, { function: "OVERVIEW", symbol: ticker }),
    alphaVantage(fetchImpl, apiKey, { function: "INCOME_STATEMENT", symbol: ticker }),
    alphaVantage(fetchImpl, apiKey, { function: "BALANCE_SHEET", symbol: ticker }),
    alphaVantage(fetchImpl, apiKey, { function: "CASH_FLOW", symbol: ticker }),
  ]);
  return { overview, income, balance, cashflow };
}

export function createApp({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
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
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(cors(buildCors(env)));
  app.use(express.json({ limit: "32kb" }));

  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      console.log(JSON.stringify(requestLogLine(req, res, Date.now() - started)));
    });
    next();
  });

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

  const searchLimiter = apiLimiter(env, "RATE_LIMIT_SEARCH", 60);
  const quotesLimiter = apiLimiter(env, "RATE_LIMIT_QUOTES", 30);
  const analyzeLimiter = apiLimiter(env, "RATE_LIMIT_ANALYZE", 10);
  const testLimiter = apiLimiter(env, "RATE_LIMIT_TEST_CONNECTION", 10);

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
    const ticker = String(req.body?.ticker || "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
      res.status(400).json({ error: "ticker is required" });
      return;
    }

    if (req.body?.replay === true) {
      const study = CASE_STUDIES[ticker];
      if (!study) {
        res.status(404).json({ error: "No sample case study for that ticker" });
        return;
      }
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
  const app = createApp({ env });
  const server = createServer(app);
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ msg: "listening", port, nodeEnv: env.NODE_ENV || "development" }));
  });
  return server;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry === import.meta.url) {
  start();
}
