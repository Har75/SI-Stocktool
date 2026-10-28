/**
 * Per-user portfolio holdings.
 *
 * Default mode is a percentage of the portfolio. Those weights are not a euro
 * total. Share counts are never stored in plaintext: the client sends
 * AES-GCM ciphertext (quantityCipher) and a PBKDF2 salt (kdf). This server
 * does not have the PIN, does not derive a key, and does not decrypt.
 * There is no recovery key. Forgetting the PIN, or resetting the account
 * password, does not restore share counts.
 *
 * Percent holdings may sum to less than 100. They may not sum to more than 100.
 */

import { Buffer } from "node:buffer";
import { normalizeTicker } from "./http-security.js";
import { cleanText } from "./watchlist.js";

export const MAX_HOLDINGS = 40;
export const KDF_ITERATIONS = 210_000;
const PERCENT_SCALE = 2;
const MAX_PERCENT_UNITS = 100 * 10 ** PERCENT_SCALE;
const PLAIN_QUANTITY_KEYS = ["quantity", "shares", "shareCount", "units"];

function decimalUnits(text, scale) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const whole = match[1];
  const frac = match[2] || "";
  if (whole.length > 15) return null;
  let kept = frac.slice(0, scale);
  while (kept.length < scale) kept += "0";
  const factor = 10 ** scale;
  let units = Number(whole) * factor + Number(kept || "0");
  if (!Number.isFinite(units)) return null;
  if (frac.length > scale && frac[scale] >= "5") units += 1;
  return units;
}

function measureUnits(value, scale) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    return decimalUnits(trimmed, scale);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const text = value.toFixed(scale + 2);
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return decimalUnits(text, scale);
}

function unitsToNumber(units, scale) {
  const factor = 10 ** scale;
  const whole = Math.trunc(units / factor);
  const frac = Math.abs(units % factor);
  if (frac === 0) return whole;
  const digits = String(frac).padStart(scale, "0").replace(/0+$/, "");
  return Number(`${whole}.${digits}`);
}

export function parsePercent(value) {
  const units = measureUnits(value, PERCENT_SCALE);
  if (units == null || units <= 0 || units > MAX_PERCENT_UNITS) return null;
  return unitsToNumber(units, PERCENT_SCALE);
}

function percentUnits(value) {
  const units = measureUnits(value, PERCENT_SCALE);
  return units == null ? null : units;
}

export function fromBase64(text) {
  if (typeof text !== "string" || text.length < 4 || text.length > 1024 || text.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const buf = Buffer.from(text, "base64");
  if (!buf.length || buf.toString("base64") !== text) return null;
  return buf;
}

export function plainQuantityError(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  for (const key of PLAIN_QUANTITY_KEYS) {
    if (body[key] != null && body[key] !== "") {
      return {
        error: "Share counts stay on this device. Send quantityCipher, not a plaintext quantity.",
        status: 400,
      };
    }
  }
  return null;
}

export function portfolioMaterialError(body) {
  const plain = plainQuantityError(body);
  if (plain) return plain;
  if (body && typeof body === "object" && (body.quantityCipher != null || body.kdf != null || body.percent != null)) {
    return { error: "This route does not accept portfolio holdings.", status: 400 };
  }
  return null;
}

function parseCipher(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.v !== 1) return null;
  const iv = fromBase64(value.iv);
  const ct = fromBase64(value.ct);
  if (!iv || iv.length !== 12) return null;
  if (!ct || ct.length < 16 || ct.length > 512) return null;
  const asText = ct.toString("utf8");
  if (/^\d+(\.\d+)?$/.test(asText)) return null;
  if (asText.includes("{") && /"q"\s*:/.test(asText)) return null;
  return { v: 1, iv: value.iv, ct: value.ct };
}

function parseKdf(value) {
  if (value == null) return { kdf: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "kdf is invalid", status: 400 };
  }
  if (value.v !== 1 || value.hash !== "SHA-256" || value.iterations !== KDF_ITERATIONS) {
    return { error: "kdf is invalid", status: 400 };
  }
  const salt = fromBase64(value.salt);
  if (!salt || salt.length !== 16) return { error: "kdf is invalid", status: 400 };
  return { kdf: { v: 1, hash: "SHA-256", iterations: KDF_ITERATIONS, salt: value.salt } };
}

export function emptyPortfolio() {
  return { kdf: null, holdings: [] };
}

export function normalizePortfolio(value) {
  const source = Array.isArray(value) ? { kdf: null, holdings: value } : value;
  if (!source || typeof source !== "object") return emptyPortfolio();
  const parsedKdf = parseKdf(source.kdf);
  const kdf = parsedKdf.error ? null : parsedKdf.kdf;
  const holdings = [];
  if (Array.isArray(source.holdings)) {
    for (const item of source.holdings) {
      const holding = sanitizeStoredHolding(item);
      if (holding) holdings.push(holding);
    }
  }
  const record = { kdf, holdings };
  return refreshKdf(record);
}

function sanitizeStoredHolding(item) {
  if (!item || typeof item !== "object") return null;
  const ticker = normalizeTicker(item.ticker);
  if (!ticker) return null;
  const label = typeof item.label === "string" && item.label ? item.label : ticker;
  if (item.mode === "percent") {
    const percent = parsePercent(item.percent);
    if (percent == null) return null;
    return { ticker, label, mode: "percent", percent, quantityCipher: null };
  }
  if (item.mode === "quantity") {
    const quantityCipher = parseCipher(item.quantityCipher);
    if (!quantityCipher) return null;
    return { ticker, label, mode: "quantity", percent: null, quantityCipher };
  }
  return null;
}

function clonePortfolio(record) {
  const normalized = normalizePortfolio(record);
  return {
    kdf: normalized.kdf ? { ...normalized.kdf } : null,
    holdings: normalized.holdings.map((item) => ({
      ...item,
      quantityCipher: item.quantityCipher ? { ...item.quantityCipher } : null,
    })),
  };
}

function refreshKdf(record) {
  if (!record.holdings.some((item) => item.mode === "quantity")) record.kdf = null;
  return record;
}

function prepareHolding(draft) {
  const plain = plainQuantityError(draft);
  if (plain) return plain;
  if (!draft || (draft.mode !== "quantity" && draft.mode !== "percent")) {
    return { error: "mode must be quantity or percent", status: 400 };
  }
  const ticker = normalizeTicker(draft.ticker);
  if (!ticker) return { error: "ticker is required", status: 400 };
  const input = { ticker, mode: draft.mode };
  if (draft.mode === "percent") {
    const percent = parsePercent(draft.percent);
    if (percent == null) {
      return {
        error: "percent must be greater than 0 and at most 100, with up to 2 decimal places",
        status: 400,
      };
    }
    input.percent = percent;
  } else {
    const quantityCipher = parseCipher(draft.quantityCipher);
    if (!quantityCipher) return { error: "quantityCipher is required", status: 400 };
    input.quantityCipher = quantityCipher;
    const parsedKdf = parseKdf(draft.kdf);
    if (parsedKdf.error) return parsedKdf;
    input.kdf = parsedKdf.kdf;
  }
  if (Object.prototype.hasOwnProperty.call(draft, "label")) {
    const label = cleanText(draft.label, 80);
    if (label == null) return { error: "label is invalid", status: 400 };
    input.label = label;
    input.labelSet = true;
  }
  return { input };
}

export function parseHoldingBody(body, tickerOverride) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid holding", status: 400 };
  }
  const draft = { mode: body.mode };
  draft.ticker = tickerOverride != null ? tickerOverride : body.ticker;
  if (body.mode === "percent") draft.percent = body.percent;
  if (body.mode === "quantity") {
    draft.quantityCipher = body.quantityCipher;
    if (Object.prototype.hasOwnProperty.call(body, "kdf")) draft.kdf = body.kdf;
  }
  for (const key of PLAIN_QUANTITY_KEYS) {
    if (body[key] != null && body[key] !== "") draft[key] = body[key];
  }
  if (Object.prototype.hasOwnProperty.call(body, "label")) draft.label = body.label;
  return prepareHolding(draft);
}

function holdingRecord(input, previous) {
  const label = input.labelSet ? input.label || input.ticker : previous?.label || input.ticker;
  if (input.mode === "quantity") {
    return {
      ticker: input.ticker,
      label,
      mode: "quantity",
      percent: null,
      quantityCipher: input.quantityCipher,
    };
  }
  return {
    ticker: input.ticker,
    label,
    mode: "percent",
    percent: input.percent,
    quantityCipher: null,
  };
}

function percentUnitsOf(holdings, exceptTicker) {
  let total = 0;
  for (const item of holdings) {
    if (!item || item.mode !== "percent" || item.ticker === exceptTicker) continue;
    const units = percentUnits(item.percent);
    if (units == null) continue;
    total += units;
  }
  return total;
}

function fitsPercent(holdings, input, exceptTicker) {
  if (input.mode !== "percent") return { ok: true };
  const next = percentUnitsOf(holdings, exceptTicker) + percentUnits(input.percent);
  if (next > MAX_PERCENT_UNITS) {
    return {
      error:
        "Percent holdings would add up to more than 100%. Lower a percentage or switch a holding to a share count. Totals under 100% are allowed.",
      status: 400,
    };
  }
  return { ok: true };
}

function applyKdf(record, input) {
  if (input.mode !== "quantity") return { ok: true };
  if (!record.kdf) {
    if (!input.kdf) return { error: "kdf is required for the first encrypted holding", status: 400 };
    record.kdf = input.kdf;
    return { ok: true };
  }
  if (input.kdf && input.kdf.salt !== record.kdf.salt) {
    return { error: "portfolio key salt does not match", status: 409 };
  }
  return { ok: true };
}

export function publicHolding(item) {
  const mode = item?.mode === "quantity" ? "quantity" : "percent";
  return {
    ticker: item.ticker,
    label: item.label || item.ticker,
    mode,
    percent: mode === "percent" ? (item.percent ?? null) : null,
    quantityCipher: mode === "quantity" && item.quantityCipher ? { ...item.quantityCipher } : null,
  };
}

export function allocationOf(items) {
  const holdings = Array.isArray(items) ? items : [];
  const units = percentUnitsOf(holdings);
  const percentCount = holdings.filter((item) => item?.mode === "percent").length;
  const quantityCount = holdings.filter((item) => item?.mode === "quantity").length;
  const percentSum = unitsToNumber(units, PERCENT_SCALE);
  let status = "none";
  let message = "";
  if (percentCount > 0 && units === MAX_PERCENT_UNITS) {
    status = "complete";
    message = "Percent holdings add up to 100%.";
  } else if (percentCount > 0 && units < MAX_PERCENT_UNITS) {
    status = "under";
    message = `Percent holdings add up to ${percentSum.toFixed(2)}%. The remainder is unallocated. A total of 100% is not required.`;
  } else if (percentCount > 0) {
    status = "over";
    message = `Percent holdings add up to ${percentSum.toFixed(2)}%, which is above 100%. Lower a percentage or remove a holding.`;
  } else if (quantityCount > 0) {
    message = "Encrypted share counts are stored. They are not portfolio weights, because that would need a portfolio total.";
  }
  return { percentSum, target: 100, status, message };
}

export function presentPortfolio(record, holding) {
  const current = normalizePortfolio(record);
  const body = {
    holdings: current.holdings.map(publicHolding),
    allocation: allocationOf(current.holdings),
    kdf: current.kdf ? { ...current.kdf } : null,
  };
  if (holding) body.holding = publicHolding(holding);
  return body;
}

export function anonymousWeights(record) {
  const current = normalizePortfolio(record);
  const weights = current.holdings
    .filter((item) => item.mode === "percent")
    .map((item) => ({ ticker: item.ticker, weight: item.percent }));
  return {
    weights,
    percentSum: allocationOf(current.holdings).percentSum,
    note: "Weights only. Share counts are not included.",
  };
}

export function addHolding(record, raw) {
  const prepared = prepareHolding(raw?.input ? raw.input : raw);
  if (prepared.error) return prepared;
  const input = prepared.input;
  const next = clonePortfolio(record);
  if (next.holdings.some((item) => item.ticker === input.ticker)) {
    return { error: "Ticker is already in the portfolio", status: 409 };
  }
  if (next.holdings.length >= MAX_HOLDINGS) {
    return { error: `Portfolio is limited to ${MAX_HOLDINGS} holdings`, status: 400 };
  }
  const fit = fitsPercent(next.holdings, input);
  if (fit.error) return fit;
  const keyed = applyKdf(next, input);
  if (keyed.error) return keyed;
  const item = holdingRecord(input, null);
  next.holdings.push(item);
  return { record: refreshKdf(next), item };
}

export function updateHolding(record, ticker, raw) {
  const prepared = prepareHolding({ ...(raw?.input ? raw.input : raw), ticker });
  if (prepared.error) return prepared;
  const input = prepared.input;
  const next = clonePortfolio(record);
  const index = next.holdings.findIndex((item) => item.ticker === input.ticker);
  if (index === -1) return { error: "Ticker is not in the portfolio", status: 404 };
  const fit = fitsPercent(next.holdings, input, input.ticker);
  if (fit.error) return fit;
  const keyed = applyKdf(next, input);
  if (keyed.error) return keyed;
  const item = holdingRecord(input, next.holdings[index]);
  next.holdings[index] = item;
  return { record: refreshKdf(next), item };
}

export function removeHolding(record, ticker) {
  const normalized = normalizeTicker(ticker);
  if (!normalized) return { error: "ticker is required", status: 400 };
  const next = clonePortfolio(record);
  if (!next.holdings.some((item) => item.ticker === normalized)) {
    return { error: "Ticker is not in the portfolio", status: 404 };
  }
  next.holdings = next.holdings.filter((item) => item.ticker !== normalized);
  return { record: refreshKdf(next) };
}
