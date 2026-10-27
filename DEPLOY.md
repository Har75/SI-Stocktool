# Deploy notes

Do not put a real Alpha Vantage key, Stripe secret, webhook secret, or admin password in the image, `fly.toml`, or git. Public hosting runs with `NODE_ENV=production`. In that mode every Alpha Vantage route, including `/api/test-connection` and watchlist re-score, requires a key sent on the request (`x-api-key` or JSON `apiKey`). The server does not fall back to `ALPHA_VANTAGE_API_KEY`.

Leave that variable for local Docker only (`compose.yaml` sets `NODE_ENV=development` so the fallback works on your machine).

The UI is served by the same process, so CORS stays same-origin unless you set `ALLOWED_ORIGIN` to an extra browser origin. Allowed origins are not given cookie credentials. Browser sessions use the same-origin cookie. API clients, including the weekly re-score, send `Authorization: Bearer`.

## Accounts and Stripe

Set these in the host's secret store, not in the repo:

- `ADMIN_EMAIL` — this address is the admin (Harald's login).
- `ADMIN_PASSWORD` — used to create that account on first boot if it does not exist. At least 10 characters, at most 72 bytes. If this is unset on a public host, the first person who signs up with `ADMIN_EMAIL` becomes admin.
- `DATA_DIR` — directory for `store.json`. The image uses `/app/data`.
- `STRIPE_SECRET_KEY` — `sk_test_` or `sk_live_`.
- `STRIPE_WEBHOOK_SECRET` — signing secret for `POST /api/stripe/webhook`.
- `STRIPE_PRICE_ID` — recurring price id (`price_...`).
- `PUBLIC_BASE_URL` — origin only, `https://your-host` in production. `http://` is accepted only for `localhost` and `127.0.0.1`.

Checkout success sets `plan=pro` and stores `stripeCustomerId`. A canceled subscription, a deleted subscription, or a failed subscription invoice sets `plan=free`. Admin accounts can use Stock Analyzer and the watchlist even on the free plan. Webhooks that fail signature verification are rejected.

The JSON file is the account database. Run one instance. A restart without a persistent disk at `DATA_DIR` drops accounts. Do not scale horizontally on this file.

## Weekly re-score

The weekly Grok routine calls the API. It does not read a key baked into the image.

1. `POST /api/auth/login` with the user's email and password. The JSON response includes `token`.
2. `GET /api/watchlist` with `Authorization: Bearer <token>`.
3. `POST /api/watchlist/reanalyze` with the same bearer token, header `x-api-key: <Alpha Vantage key>`, and body `{"all": true}` or `{"ticker":"NOK"}`.

Bearer calls do not send the session cookie, so they do not send `x-csrf-token`. The browser does not store the bearer token. Sessions last 14 days (`SESSION_TTL_HOURS`) and then login returns 401.

## Local Stripe test mode

```bash
npm install
npm test
```

Fill a gitignored `.env` from `.env.example` with your Stripe test secret, a test `price_...`, and `PUBLIC_BASE_URL=http://127.0.0.1:4721`. Create the admin before exposing the port:

```bash
# .env is not committed
node --env-file=.env src/server.js
```

In another terminal, forward signed webhooks:

```bash
stripe listen --forward-to localhost:4721/api/stripe/webhook
```

Put the printed `whsec_` value in `STRIPE_WEBHOOK_SECRET` and start the server again. Open `http://127.0.0.1:4721`, sign up or log in as the admin, and use Upgrade. Stripe's test card is `4242 4242 4242 4242`. After the webhook, reload the page; the plan should be Pro. Stock Analyzer then asks "Add to watchlist?". Cancel the subscription in the billing portal (or `stripe trigger invoice.payment_failed` after a customer is linked) and the plan returns to Free.

`npm start` does not load `.env` by itself. Use `node --env-file=.env` locally. Docker Compose reads a local `.env` for the variables listed in `compose.yaml` and still sets `NODE_ENV=development`.

Open `http://127.0.0.1:4721`. Portfolio stores percentages for the signed-in user, and share counts only as ciphertext. Replay `NOK` after you are Pro or admin. A quotes request with 21 tickers returns HTTP 400. The Pro chart reads `POST /api/series` with the browser key. Weekly jobs that need portfolio context should call `GET /api/portfolio/weights`, which returns weights only.

## Threat notes

- Passwords are hashed with bcrypt (cost 12 in production, never below that). The plaintext is not logged, stored, or returned.
- Session tokens are random and stored as SHA-256. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when `NODE_ENV=production`. `COOKIE_SECURE=0` turns Secure off; do not set that on a public host.
- Cookie-authenticated POST, DELETE, and other changes require `x-csrf-token` from `/api/auth/me` or login. Bearer clients skip that header because the browser will not attach a bearer token on its own.
- Login JSON includes `token` for the weekly client. The page keeps the cookie and does not save the token. CSP allows scripts only from this origin.
- Stock Analyzer (live and replay), the price-series chart, and every watchlist route check the signed-in user on the server. A free plan is rejected even if the page is modified. Portfolio list, add, update, and delete require a signed-in user and do not require Pro. Admin routes require `role=admin`.
- Portfolio share counts are client-encrypted (AES-GCM, PIN-derived PBKDF2). The server stores ciphertext and the salt. It never stores or logs a plaintext quantity, and it has no key to decrypt one. There is no recovery key: a lost PIN or an account-password reset does not restore share counts. Re-score rejects portfolio material. `GET /api/portfolio/weights` is the bot-facing view and contains weights only.
- Stripe webhooks require a verified signature. Card data is not read or logged. Logs are method, path, status, and a short event type.
- Request bodies, API keys, passwords, session tokens, and webhook payloads are not logged. Upstream errors are scrubbed of the client key.
- Rate limits cover search, quotes, analyze, test-connection, signup, login, watchlist, portfolio, series, re-score, admin, billing, and the webhook.
- The store writes JSON by replace-via-temp-file with mode `0600`. Paths are not taken from requests. Tickers are capped (20 quotes, 20 watchlist names) and fields have length limits.
- Helmet stays on, including a locked content security policy. CORS stays same-origin unless `ALLOWED_ORIGIN` is set, and that list does not enable cookie credentials.
- No Alpha Vantage key, Stripe secret, or admin password is copied into the image.

## Render

1. New Web Service from this repo. Choose the Docker runtime so the image sets `NODE_ENV=production` and runs as the `node` user.
2. Render injects `PORT`. The server uses `process.env.PORT` or `4721`. If you pin a port in the dashboard, use `4721`.
3. Health check path: `/api/health`.
4. Do not set `ALPHA_VANTAGE_API_KEY`. Visitors paste their own key in the page. The weekly routine sends its own key per request.
5. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, and `PUBLIC_BASE_URL` in the dashboard. Point the Stripe webhook at `https://<service>/api/stripe/webhook`.
6. Optional persistent disk mounted at `/app/data` with `DATA_DIR=/app/data`. Without it, accounts disappear on restart. Keep a single instance while the store is a file.
7. Optional: `ALLOWED_ORIGIN` only if another site calls the API.

## Fly

1. Install `flyctl` and `fly auth login` on your machine.
2. If the app name `si-stocktool` is taken, change `app` in `fly.toml`.
3. `fly launch --copy-config --no-deploy` then `fly deploy` when you are ready.
4. `fly.toml` sets `PORT=4721`, `NODE_ENV=production`, and checks `/api/health`.
5. Do not run `fly secrets set ALPHA_VANTAGE_API_KEY=...` for a public desk. Do set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and the Stripe variables with `fly secrets set`.
6. A Fly volume mounted at `/app/data` keeps accounts across deploys. One machine, because the file is not shared.
