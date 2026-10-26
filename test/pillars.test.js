import assert from "node:assert/strict";
import test from "node:test";
import { CASE_STUDIES, SAMPLE_BOOK } from "../src/demo-data.js";
import { fundamentalsFromAlphaVantage, scorePillars } from "../src/pillars.js";

test("sample book is a small fictional tape", () => {
  const tickers = SAMPLE_BOOK.positions.map((position) => position.ticker);
  assert.deepEqual(tickers, ["SPCX", "NOK", "AIFS", "QOMP", "4MMR"]);
  const total = SAMPLE_BOOK.positions.reduce(
    (sum, position) => sum + position.shares * position.markPerShareEur,
    0,
  );
  assert.ok(total > 0);
  assert.ok(total < 10_000);
  const text = JSON.stringify(SAMPLE_BOOK).toLowerCase();
  assert.match(SAMPLE_BOOK.disclaimer, /fictional sample book/i);
  assert.equal(text.includes("million"), false);
  assert.equal(text.includes("private wealth"), false);
});

test("each sample ticker has a replay case", () => {
  for (const position of SAMPLE_BOOK.positions) {
    assert.ok(CASE_STUDIES[position.ticker]);
  }
});

test("NOK replay composite stays on the published bands", () => {
  const scored = scorePillars(CASE_STUDIES.NOK.fundamentals);
  assert.equal(scored.pillarCount, 8);
  assert.equal(scored.scoredCount, 8);
  assert.deepEqual(
    scored.pillars.map((pillar) => pillar.score),
    [55, 65, 60, 60, 75, 72, 80, 86],
  );
  assert.equal(scored.composite, 69);
});

test("alpha vantage statements map into the same Stock analyzer scores", () => {
  const fundamentals = fundamentalsFromAlphaVantage({
    overview: {
      Name: "Sample Co",
      OperatingMarginTTM: "0.11",
      ProfitMargin: "0.09",
      ReturnOnEquityTTM: "0.14",
      QuarterlyEarningsGrowthYOY: "0.04",
      DividendYield: "0.03",
      PERatio: "16",
    },
    income: {
      annualReports: [{ totalRevenue: "110.25" }, { totalRevenue: "105" }, { totalRevenue: "100" }],
    },
    balance: {
      annualReports: [
        { totalShareholderEquity: "80", shortLongTermDebtTotal: "32", commonStockSharesOutstanding: "990" },
        { commonStockSharesOutstanding: "1000" },
      ],
    },
    cash: {
      annualReports: [{ operatingCashflow: "12", capitalExpenditures: "-3.18" }],
    },
  });
  const scored = scorePillars(fundamentals);
  assert.equal(fundamentals.debtToEquity, 0.4);
  assert.ok(Math.abs(fundamentals.fcfMargin - 0.08) < 0.01);
  assert.equal(scored.composite, 69);
});
