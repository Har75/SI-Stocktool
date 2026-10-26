# SI StockTool

Sample research desk: an Express server proxies Alpha Vantage for search, quotes, and a Stock analyzer. Accounts are email and password. Stock Analyzer and the watchlist require a Pro plan or an admin. The page also replays invented fundamentals for the sample tickers SPCX, NOK, AIFS, QOMP, and 4MMR.

The GitHub repo started as a README only. The earlier Origin draft `harald-jansen/tmp-938a47e733973959` was not readable from the environment that prepared this tree (git auth failed, and no local checkout was present). This tree follows that known shape: `src/server.js`, `public/`, `compose.yaml` publishing host port 80 to container port 4721, and a Docker image.

## Run locally

```bash
npm install
npm test
npm start
```

The dev server listens on port `4721`. Copy `.env.example` to `.env` (that file stays untracked) and start with the env file when you want accounts or Stripe test mode:

```bash
node --env-file=.env src/server.js
```

See [DEPLOY.md](DEPLOY.md) for Stripe CLI webhook forwarding, the admin seed, and the weekly re-score call. With Docker:

```bash
# optional, local only — never commit a real key
export ALPHA_VANTAGE_API_KEY=your_local_key
docker compose up --build
```

Compose maps `80:4721` and sets `NODE_ENV=development` so the env key can fill in when the page key is blank. The image itself defaults to `NODE_ENV=production`.

## Portfolio

The Portfolio section is a fictional tape with small invented euro marks. The marks are a sample, not a statement of holdings. Search and live quotes stay available without an account.

Replay mode scores the same five tickers from baked-in fundamentals and does not call Alpha Vantage. Live mode needs a browser-supplied key when `NODE_ENV=production`. Both replay and live Stock Analyzer calls require a signed-in Pro user or an admin. After a score, the page asks “Add to watchlist?”. The watchlist is stored on the server for that user.

## Accounts

Signup and login use a bcrypt password hash and a session token. The browser gets an HTTP-only cookie. A weekly client can send `Authorization: Bearer` plus `x-api-key` to `POST /api/watchlist/reanalyze`. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` so the admin account exists before the service is reachable. Stripe Checkout and the billing portal are documented in [DEPLOY.md](DEPLOY.md). Do not commit secrets.

## Stock Analyzer

The Stock analyzer scores eight dimensions: profitability, capital returns, revenue growth, earnings growth, balance sheet, cash generation, shareholder alignment, and valuation. Each band is 0–100. The composite is the average of dimensions that have data. The score is a teaching device for case studies.

## Hosting

See [DEPLOY.md](DEPLOY.md) for Render and Fly. This repository does not deploy itself.

Production behavior:

- Rate limits per IP: search 60/min, quotes 30/min, analyze 10/min, test-connection 10/min, signup 5/min, login 10/min, watchlist 30/min, re-score 10/min.
- `/api/quotes` accepts at most 20 tickers.
- Helmet security headers, and CORS limited to same-origin unless `ALLOWED_ORIGIN` is set.
- Request logs are method, path, and status only. Bodies and keys are not logged.
- No API key is baked into the image.
