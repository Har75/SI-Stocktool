/**
 * Eight-pillar case-study calculator.
 * Scores are coarse educational bands (0–100), shared by live Alpha Vantage
 * snapshots and the offline replay fixtures.
 */

const HIGH = [
  [0.2, 90],
  [0.12, 75],
  [0.06, 55],
  [0, 40],
];

const GROWTH = [
  [0.15, 90],
  [0.08, 75],
  [0.03, 60],
  [0, 40],
];

const ROE = [
  [0.2, 90],
  [0.15, 78],
  [0.1, 65],
  [0.05, 45],
];

const FCF = [
  [0.12, 90],
  [0.06, 72],
  [0.02, 55],
  [0, 40],
];

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ladderHigh(value, steps, floor = 15) {
  const n = finite(value);
  if (n == null) return null;
  for (const [min, score] of steps) {
    if (n >= min) return score;
  }
  return floor;
}

function ladderLow(value, steps, floor = 15) {
  const n = finite(value);
  if (n == null) return null;
  for (const [max, score] of steps) {
    if (n <= max) return score;
  }
  return floor;
}

function pillar(id, name, score, note) {
  return { id, name, score, max: 100, note };
}

function scorePe(pe) {
  const n = finite(pe);
  if (n == null || n <= 0) return null;
  if (n < 8) return 60;
  if (n <= 18) return 86;
  if (n <= 28) return 68;
  if (n <= 40) return 48;
  return 28;
}

export function scorePillars(input = {}) {
  const profitability = ladderHigh(input.operatingMargin ?? input.profitMargin, HIGH, 15);
  const capital = ladderHigh(input.roe ?? input.roa, ROE, 20);
  const revenue = ladderHigh(input.revenueGrowth, GROWTH, 20);
  const earnings = ladderHigh(input.earningsGrowth, GROWTH, 20);
  const balance = ladderLow(
    input.debtToEquity,
    [
      [0.3, 90],
      [0.8, 75],
      [1.5, 55],
      [3, 35],
    ],
    15,
  );
  const cash = ladderHigh(input.fcfMargin, FCF, 18);
  let shareholder = ladderLow(
    input.shareChange,
    [
      [-0.02, 88],
      [0, 74],
      [0.02, 55],
      [0.05, 40],
    ],
    22,
  );
  if (shareholder != null && finite(input.dividendYield) != null && input.dividendYield >= 0.02) {
    shareholder = Math.min(95, shareholder + 6);
  }
  const valuation = scorePe(input.peRatio);

  const pillars = [
    pillar(
      "profitability",
      "Profitability",
      profitability,
      profitability == null
        ? "No margin in this snapshot."
        : "Operating margin, or profit margin when operating margin is absent.",
    ),
    pillar(
      "capital-returns",
      "Capital returns",
      capital,
      capital == null ? "No ROE or ROA in this snapshot." : "Return on equity, or ROA when ROE is absent.",
    ),
    pillar(
      "revenue-growth",
      "Revenue growth",
      revenue,
      revenue == null ? "No revenue growth in this snapshot." : "Revenue CAGR or trailing growth rate.",
    ),
    pillar(
      "earnings-growth",
      "Earnings growth",
      earnings,
      earnings == null ? "No earnings growth in this snapshot." : "Earnings growth rate in the snapshot.",
    ),
    pillar(
      "balance-sheet",
      "Balance sheet",
      balance,
      balance == null ? "No debt-to-equity in this snapshot." : "Lower debt-to-equity scores higher.",
    ),
    pillar(
      "cash",
      "Cash generation",
      cash,
      cash == null ? "No free-cash-flow margin in this snapshot." : "Free cash flow divided by revenue.",
    ),
    pillar(
      "shareholder",
      "Shareholder alignment",
      shareholder,
      shareholder == null
        ? "No share-count change in this snapshot."
        : "Buybacks score higher than dilution. A dividend yield of 2% or more adds a small bump.",
    ),
    pillar(
      "valuation",
      "Valuation",
      valuation,
      valuation == null ? "No positive P/E in this snapshot." : "Mid-teens P/E scores highest in this band.",
    ),
  ];

  const scored = pillars.filter((item) => item.score != null);
  const composite = scored.length
    ? Math.round(scored.reduce((sum, item) => sum + item.score, 0) / scored.length)
    : null;

  return {
    pillarCount: 8,
    scoredCount: scored.length,
    composite,
    pillars,
  };
}

export function parseAvNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === "None" || text === "-" || text.toLowerCase() === "null") return null;
  const n = Number(text.replace(/[%$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Alpha Vantage ratios arrive as decimals ("0.15") or percents ("15"). */
export function asRatio(value) {
  const n = parseAvNumber(value);
  if (n == null) return null;
  return Math.abs(n) > 2 ? n / 100 : n;
}

function revenueCagr(revenuesNewestFirst) {
  const series = (revenuesNewestFirst || []).filter((n) => finite(n) != null && n > 0);
  if (series.length < 2) return null;
  const latest = series[0];
  const oldest = series[series.length - 1];
  const years = series.length - 1;
  if (oldest <= 0 || years < 1) return null;
  return (latest / oldest) ** (1 / years) - 1;
}

function debtToEquity(balance) {
  if (!balance) return null;
  const equity = parseAvNumber(balance.totalShareholderEquity);
  if (equity == null || equity <= 0) return null;
  const combined = parseAvNumber(balance.shortLongTermDebtTotal);
  const debt =
    combined != null
      ? combined
      : (parseAvNumber(balance.shortTermDebt) || 0) + (parseAvNumber(balance.longTermDebt) || 0);
  if (!Number.isFinite(debt)) return null;
  return debt / equity;
}

function fcfMargin(cash, revenue) {
  if (!cash || revenue == null || revenue <= 0) return null;
  const ocf = parseAvNumber(cash.operatingCashflow);
  const capex = parseAvNumber(cash.capitalExpenditures);
  if (ocf == null) return null;
  const spent = capex == null ? 0 : capex < 0 ? -capex : capex;
  return (ocf - spent) / revenue;
}

export function fundamentalsFromAlphaVantage({ overview = {}, income = {}, balance = {}, cash = {} } = {}) {
  const annualIncome = Array.isArray(income.annualReports) ? income.annualReports : [];
  const annualBalance = Array.isArray(balance.annualReports) ? balance.annualReports : [];
  const annualCash = Array.isArray(cash.annualReports) ? cash.annualReports : [];
  const revenues = annualIncome.map((row) => parseAvNumber(row.totalRevenue)).filter((n) => n != null);
  const latestRevenue = revenues[0] ?? null;
  const sharesNow = parseAvNumber(annualBalance[0]?.commonStockSharesOutstanding);
  const sharesPrev = parseAvNumber(annualBalance[1]?.commonStockSharesOutstanding);
  let shareChange = null;
  if (sharesNow != null && sharesPrev != null && sharesPrev > 0) {
    shareChange = (sharesNow - sharesPrev) / sharesPrev;
  }

  return {
    name: overview.Name || null,
    operatingMargin: asRatio(overview.OperatingMarginTTM),
    profitMargin: asRatio(overview.ProfitMargin),
    roe: asRatio(overview.ReturnOnEquityTTM),
    roa: asRatio(overview.ReturnOnAssetsTTM),
    revenueGrowth: revenueCagr(revenues) ?? asRatio(overview.QuarterlyRevenueGrowthYOY),
    earningsGrowth: asRatio(overview.QuarterlyEarningsGrowthYOY),
    debtToEquity: debtToEquity(annualBalance[0]),
    fcfMargin: fcfMargin(annualCash[0], latestRevenue),
    shareChange,
    dividendYield: asRatio(overview.DividendYield),
    peRatio: parseAvNumber(overview.PERatio),
  };
}
