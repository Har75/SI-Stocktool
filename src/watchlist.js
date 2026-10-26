export const MAX_WATCHLIST = 20;

export function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length > max) return null;
  return cleaned;
}

export function parseComposite(value) {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    return { ok: false, value: null };
  }
  return { ok: true, value };
}

export function publicWatchItem(item) {
  return {
    ticker: item.ticker,
    label: item.label || item.ticker,
    lastComposite: item.lastComposite ?? null,
    previousComposite: item.previousComposite ?? null,
    lastRunAt: item.lastRunAt || null,
    note: item.note || "",
  };
}

export function upsertWatchItem(items, input, nowIso) {
  const list = Array.isArray(items) ? items.map((item) => ({ ...item })) : [];
  const index = list.findIndex((item) => item.ticker === input.ticker);
  if (index === -1 && list.length >= MAX_WATCHLIST) {
    return { error: `Watchlist is limited to ${MAX_WATCHLIST} tickers` };
  }
  const current = index === -1 ? null : list[index];
  const hasComposite = Object.prototype.hasOwnProperty.call(input, "composite");
  const hasNote = Object.prototype.hasOwnProperty.call(input, "note");
  let lastComposite = current ? (current.lastComposite ?? null) : null;
  let previousComposite = current ? (current.previousComposite ?? null) : null;
  let lastRunAt = current ? current.lastRunAt || nowIso : nowIso;
  if (!current || hasComposite) {
    if (current && hasComposite) previousComposite = current.lastComposite ?? null;
    lastComposite = hasComposite ? input.composite : null;
    lastRunAt = nowIso;
  }
  const next = {
    ticker: input.ticker,
    label: input.label || current?.label || input.ticker,
    lastComposite,
    previousComposite,
    lastRunAt,
    note: hasNote ? input.note : current?.note || "",
  };
  if (index === -1) list.push(next);
  else list[index] = next;
  return { items: list, item: next };
}

export function applyRescore(item, { composite, label, nowIso }) {
  return {
    ...item,
    label: label || item.label || item.ticker,
    previousComposite: item.lastComposite ?? null,
    lastComposite: composite ?? null,
    lastRunAt: nowIso,
  };
}
