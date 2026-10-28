const AV_URL = "https://www.alphavantage.co/query";

export async function alphaVantage(fetchImpl, apiKey, params) {
  const url = new URL(AV_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("apikey", apiKey);
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch {
    const error = new Error("upstream unavailable");
    error.code = "UPSTREAM_NETWORK";
    throw error;
  }
  try {
    return await response.json();
  } catch {
    const error = new Error("upstream invalid");
    error.code = "UPSTREAM_INVALID";
    throw error;
  }
}

export function upstreamProblem(payload) {
  if (!payload || typeof payload !== "object") return "Empty response from Alpha Vantage.";
  if (payload["Error Message"]) return String(payload["Error Message"]);
  if (payload.Note) return String(payload.Note);
  if (payload.Information) return String(payload.Information);
  return null;
}

export function quoteFromGlobal(payload, fallbackSymbol) {
  const quote = payload?.["Global Quote"];
  const price = quote?.["05. price"];
  if (!quote || price == null || price === "" || price === "None") return null;
  return {
    ticker: quote["01. symbol"] || fallbackSymbol,
    price,
    change: quote["09. change"] ?? null,
    changePercent: quote["10. change percent"] ?? null,
    latestTradingDay: quote["07. latest trading day"] ?? null,
  };
}

export function seriesCloses(payload, key, limit = 160) {
  const table = payload?.[key];
  if (!table || typeof table !== "object" || Array.isArray(table)) return [];
  const points = [];
  for (const [stamp, row] of Object.entries(table)) {
    if (!/^\d{4}-\d{2}-\d{2}(?:\s\d{2}:\d{2}:\d{2})?$/.test(stamp)) continue;
    const close = Number(row?.["4. close"]);
    if (!Number.isFinite(close) || close < 0) continue;
    points.push({ t: stamp, close });
  }
  points.sort((left, right) => (left.t < right.t ? -1 : left.t > right.t ? 1 : 0));
  const cap = Math.max(1, Math.min(limit, 400));
  return points.slice(-cap);
}

export function searchMatches(payload) {
  const rows = Array.isArray(payload?.bestMatches) ? payload.bestMatches : [];
  return rows.slice(0, 10).map((row) => ({
    symbol: row["1. symbol"] || "",
    name: row["2. name"] || "",
    type: row["3. type"] || "",
    region: row["4. region"] || "",
    currency: row["8. currency"] || "",
  }));
}
