/**
 * Fictional sample book and offline case studies.
 * Figures are play-money marks for the UI and Stock analyzer replay.
 * They are not an account, a statement, or live market data.
 */

export const SAMPLE_DISCLAIMER =
  "Fictional sample book for the desk UI. Tickers are sample labels and euro marks are invented. This is a classroom tape, not an account statement.";

export const SCORE_DISCLAIMER =
  "Educational Stock analyzer score. Not investment advice, not a recommendation, and not a valuation of a real portfolio.";

export const SAMPLE_BOOK = {
  id: "sample-book",
  title: "Fictional sample book",
  disclaimer: SAMPLE_DISCLAIMER,
  currency: "EUR",
  positions: [
    {
      ticker: "SPCX",
      sampleName: "Sample listing SPCX",
      shares: 8,
      costPerShareEur: 25,
      markPerShareEur: 30,
      note: "Invented mark for the sample tape.",
    },
    {
      ticker: "NOK",
      sampleName: "Sample listing NOK",
      shares: 50,
      costPerShareEur: 4,
      markPerShareEur: 4.5,
      note: "Invented mark for the sample tape.",
    },
    {
      ticker: "AIFS",
      sampleName: "Sample listing AIFS",
      shares: 20,
      costPerShareEur: 10,
      markPerShareEur: 12,
      note: "Invented mark for the sample tape.",
    },
    {
      ticker: "QOMP",
      sampleName: "Sample listing QOMP",
      shares: 15,
      costPerShareEur: 20,
      markPerShareEur: 18,
      note: "Invented mark for the sample tape.",
    },
    {
      ticker: "4MMR",
      sampleName: "Sample listing 4MMR",
      shares: 10,
      costPerShareEur: 15,
      markPerShareEur: 16,
      note: "Invented mark for the sample tape.",
    },
  ],
};

const studyDisclaimer =
  "Offline replay uses invented fundamentals so the Stock analyzer can be walked through without an API key.";

function study(ticker, label, fundamentals) {
  return {
    ticker,
    label,
    disclaimer: studyDisclaimer,
    fundamentals,
  };
}

export const CASE_STUDIES = {
  SPCX: study("SPCX", "Sample case SPCX", {
    operatingMargin: 0.22,
    profitMargin: 0.16,
    roe: 0.18,
    revenueGrowth: 0.14,
    earningsGrowth: 0.11,
    debtToEquity: 0.25,
    fcfMargin: 0.13,
    shareChange: 0.01,
    dividendYield: 0,
    peRatio: 32,
  }),
  NOK: study("NOK", "Sample case NOK", {
    operatingMargin: 0.11,
    profitMargin: 0.09,
    roe: 0.14,
    revenueGrowth: 0.05,
    earningsGrowth: 0.04,
    debtToEquity: 0.4,
    fcfMargin: 0.08,
    shareChange: -0.01,
    dividendYield: 0.03,
    peRatio: 16,
  }),
  AIFS: study("AIFS", "Sample case AIFS", {
    operatingMargin: 0.07,
    profitMargin: 0.04,
    roe: 0.09,
    revenueGrowth: 0.21,
    earningsGrowth: 0.18,
    debtToEquity: 0.1,
    fcfMargin: 0.03,
    shareChange: 0.04,
    dividendYield: 0,
    peRatio: 44,
  }),
  QOMP: study("QOMP", "Sample case QOMP", {
    operatingMargin: 0.15,
    profitMargin: 0.1,
    roe: 0.16,
    revenueGrowth: 0.09,
    earningsGrowth: 0.07,
    debtToEquity: 0.7,
    fcfMargin: 0.07,
    shareChange: 0,
    dividendYield: 0.015,
    peRatio: 22,
  }),
  "4MMR": study("4MMR", "Sample case 4MMR", {
    operatingMargin: 0.05,
    profitMargin: 0.04,
    roe: 0.08,
    revenueGrowth: 0.03,
    earningsGrowth: 0.02,
    debtToEquity: 0.2,
    fcfMargin: 0.05,
    shareChange: 0,
    dividendYield: 0.02,
    peRatio: 14,
  }),
};

export function listCaseStudies() {
  return Object.values(CASE_STUDIES).map(({ ticker, label, disclaimer }) => ({
    ticker,
    label,
    disclaimer,
  }));
}
