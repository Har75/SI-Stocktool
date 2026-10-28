/**
 * Portfolio chart math. Runs in the browser on decrypted quantities or on
 * percent weights. It does not invent a euro total for percent-only books.
 */

export const RANGE_ORDER = ["day", "week", "month", "quarter", "half"];

const RANGE_DAYS = {
  week: 7,
  month: 31,
  quarter: 92,
  half: 183,
};

function timeMs(stamp) {
  if (stamp.includes(" ")) return Date.parse(`${stamp.replace(" ", "T")}Z`);
  return Date.parse(`${stamp}T00:00:00Z`);
}

function latestSession(points) {
  if (!points?.length) return [];
  const latest = points[points.length - 1].t.slice(0, 10);
  return points.filter((point) => point.t.slice(0, 10) === latest);
}

function windowPoints(points, range) {
  if (!points?.length) return [];
  if (range === "day") return latestSession(points);
  const days = RANGE_DAYS[range];
  if (!days) return [];
  const end = timeMs(points[points.length - 1].t);
  const start = end - days * 86_400_000;
  return points.filter((point) => timeMs(point.t) >= start);
}

function unionTimes(seriesByTicker, tickers) {
  const times = new Set();
  for (const ticker of tickers) {
    for (const point of seriesByTicker[ticker] || []) times.add(point.t);
  }
  return [...times].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function filledPrices(points, times) {
  const sorted = [...(points || [])].sort((left, right) => (left.t < right.t ? -1 : left.t > right.t ? 1 : 0));
  const out = new Map();
  let index = 0;
  let last = null;
  for (const stamp of times) {
    while (index < sorted.length && sorted[index].t <= stamp) {
      last = sorted[index].close;
      index += 1;
    }
    if (last != null && sorted.length && sorted[0].t <= stamp) out.set(stamp, last);
  }
  return out;
}

function readyTickers(rows, seriesByTicker, times) {
  return rows.filter((row) => {
    const prices = filledPrices(seriesByTicker[row.ticker], times);
    return times.length > 0 && prices.has(times[0]);
  });
}

export function buildSeries({ holdings = [], daily = {}, intraday = {}, range = "month" } = {}) {
  const decrypted = holdings.filter((item) => item.mode === "quantity" && typeof item.quantity === "number" && item.quantity > 0);
  const locked = holdings.some((item) => item.mode === "quantity" && typeof item.quantity !== "number");
  const percents = holdings.filter((item) => item.mode === "percent" && Number(item.percent) > 0);
  const source = range === "day" ? intraday : daily;
  const useValue = decrypted.length > 0;
  const rows = useValue ? decrypted : percents;
  if (!rows.length) {
    return {
      mode: "empty",
      points: [],
      caption: locked
        ? "Ontgrendel de portefeuille-PIN om een waarde uit aantallen te tekenen. Zonder aantal is er geen bedrag."
        : "Voeg een percentage toe om een index te zien, of een versleuteld aantal voor een waarde.",
    };
  }
  const times = unionTimes(
    Object.fromEntries(rows.map((row) => [row.ticker, windowPoints(source[row.ticker] || [], range)])),
    rows.map((row) => row.ticker),
  );
  const included = readyTickers(rows, source, times);
  const skipped = rows.length - included.length;
  if (!included.length || times.length === 0) {
    return {
      mode: "empty",
      points: [],
      caption: "Geen koersdata voor deze periode.",
    };
  }
  const prices = Object.fromEntries(included.map((row) => [row.ticker, filledPrices(source[row.ticker], times)]));
  const first = times[0];
  const points = [];
  if (useValue) {
    for (const stamp of times) {
      let value = 0;
      let complete = true;
      for (const row of included) {
        const price = prices[row.ticker].get(stamp);
        if (price == null) {
          complete = false;
          break;
        }
        value += row.quantity * price;
      }
      if (complete) points.push({ t: stamp, v: value });
    }
  } else {
    const base = Object.fromEntries(included.map((row) => [row.ticker, prices[row.ticker].get(first)]));
    const weightSum = included.reduce((sum, row) => sum + Number(row.percent), 0);
    for (const stamp of times) {
      let acc = 0;
      let complete = true;
      for (const row of included) {
        const price = prices[row.ticker].get(stamp);
        const start = base[row.ticker];
        if (price == null || !start) {
          complete = false;
          break;
        }
        acc += Number(row.percent) * (price / start);
      }
      if (complete && weightSum > 0) points.push({ t: stamp, v: (100 * acc) / weightSum });
    }
  }
  let caption = useValue
    ? "Som van aantal × koers, uitgerekend in deze browser. Dit is geen opgegeven portefeuillewaarde en geen euroteken."
    : "Relatieve index die op 100 start. Dit is geen bedrag in euro of dollar.";
  if (useValue && locked) caption += " Niet-ontgrendelde aantallen zijn weggelaten.";
  if (!useValue && locked) caption += " Versleutelde aantallen zitten niet in de index.";
  if (skipped > 0) caption += " Sommige tickers hebben geen koers aan het begin van deze periode.";
  return { mode: useValue ? "value" : "index", points, caption };
}
