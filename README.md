# SI StockTool

Sample research desk: an Express server proxies Alpha Vantage for search, quotes, and an eight-pillar case-study calculator. The page also replays invented fundamentals for the sample tickers SPCX, NOK, AIFS, QOMP, and 4MMR.

The GitHub repo started as a README only. The earlier Origin draft `harald-jansen/tmp-938a47e733973959` was not readable from the environment that prepared this tree (git auth failed, and no local checkout was present). This tree follows that known shape: `src/server.js`, `public/`, `compose.yaml` publishing host port 80 to container port 4721, and a Docker image.

## Run locally

```bash
npm install
npm test
npm start
```

The dev server listens on port `4721`. With Docker:

```bash
# optional, local only — never commit a real key
export ALPHA_VANTAGE_API_KEY=your_local_key
docker compose up --build
```

Compose maps `80:4721` and sets `NODE_ENV=development` so the env key can fill in when the page key is blank. The image itself defaults to `NODE_ENV=production`.

## Sample book

The book on the page is a fictional tape with small invented euro marks. It is labeled as a sample. It is not a statement of holdings.

Replay mode scores the same five tickers from baked-in fundamentals and does not call Alpha Vantage. Live mode needs a browser-supplied key when `NODE_ENV=production`.

## Eight pillars

The calculator scores profitability, capital returns, revenue growth, earnings growth, balance sheet, cash generation, shareholder alignment, and valuation. Each band is 0–100. The composite is the average of pillars that have data. The score is a teaching device for case studies.

## Hosting

See [DEPLOY.md](DEPLOY.md) for Render and Fly. This repository does not deploy itself.

Production behavior:

- Rate limits per IP: search 60/min, quotes 30/min, analyze 10/min, test-connection 10/min.
- `/api/quotes` accepts at most 20 tickers.
- Helmet security headers, and CORS limited to same-origin unless `ALLOWED_ORIGIN` is set.
- Request logs are method, path, and status only. Bodies and keys are not logged.
- No API key is baked into the image.
