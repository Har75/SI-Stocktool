# Deploy notes

Do not put a real Alpha Vantage key in the image, `fly.toml`, or git. Public hosting runs with `NODE_ENV=production`. In that mode every Alpha Vantage route, including `/api/test-connection`, requires a key sent by the browser (`x-api-key` or JSON `apiKey`). The server does not fall back to `ALPHA_VANTAGE_API_KEY`.

Leave that variable for local Docker only (`compose.yaml` sets `NODE_ENV=development` so the fallback works on your machine).

The UI is served by the same process, so CORS stays same-origin unless you set `ALLOWED_ORIGIN` to an extra browser origin.

## Render

1. New Web Service from this repo. Choose the Docker runtime so the image sets `NODE_ENV=production` and runs as the `node` user.
2. Render injects `PORT`. The server uses `process.env.PORT` or `4721`. If you pin a port in the dashboard, use `4721`.
3. Health check path: `/api/health`.
4. Do not set `ALPHA_VANTAGE_API_KEY`. Visitors paste their own key in the page.
5. Optional: `ALLOWED_ORIGIN` only if another site calls the API.

## Fly

1. Install `flyctl` and `fly auth login` on your machine.
2. If the app name `si-stocktool` is taken, change `app` in `fly.toml`.
3. `fly launch --copy-config --no-deploy` then `fly deploy` when you are ready.
4. `fly.toml` sets `PORT=4721`, `NODE_ENV=production`, and checks `/api/health`.
5. Do not run `fly secrets set ALPHA_VANTAGE_API_KEY=...` for a public desk.

Local check without deploying:

```bash
npm install
npm test
npm start
```

Open `http://127.0.0.1:4721`. Load the sample book, replay `NOK`, and confirm a quotes request with 21 tickers returns HTTP 400.
