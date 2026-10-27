import { buildSeries } from "./portfolio-chart.js";
import { createKdf, decryptQuantity, derivePortfolioKey, encryptQuantity } from "./portfolio-crypto.js";

const keyInput = document.querySelector("#api-key");
const connectionStatus = document.querySelector("#connection-status");
const accountStatus = document.querySelector("#account-status");
const upgradeStatus = document.querySelector("#upgrade-status");
const upgradeActions = document.querySelector("#upgrade-actions");
const adminPanel = document.querySelector("#admin-panel");
const adminTab = document.querySelector("#tab-admin");
const adminBody = document.querySelector("#admin-body");
const adminStatus = document.querySelector("#admin-status");
const authForms = document.querySelector("#auth-forms");
const loginPage = document.querySelector("#login-page");
const signupPage = document.querySelector("#signup-page");
const sessionPanel = document.querySelector("#session-panel");
const portfolioLocked = document.querySelector("#portfolio-locked");
const portfolioApp = document.querySelector("#portfolio-app");
const portfolioBody = document.querySelector("#portfolio-body");
const portfolioStatus = document.querySelector("#portfolio-status");
const portfolioAllocation = document.querySelector("#portfolio-allocation");
const portfolioTicker = document.querySelector("#portfolio-ticker");
const portfolioModeInput = document.querySelector("#portfolio-mode");
const portfolioValue = document.querySelector("#portfolio-value");
const portfolioValueLabel = document.querySelector("#portfolio-value-label");
const portfolioSubmit = document.querySelector("#portfolio-submit");
const portfolioCancel = document.querySelector("#portfolio-cancel");
const portfolioMatches = document.querySelector("#portfolio-matches");
const portfolioLookup = document.querySelector("#portfolio-lookup");
const portfolioPinInput = document.querySelector("#portfolio-pin-input");
const portfolioPinSubmit = document.querySelector("#portfolio-pin-submit");
const portfolioPinLock = document.querySelector("#portfolio-pin-lock");
const portfolioPinStatus = document.querySelector("#portfolio-pin-status");
const portfolioChartLocked = document.querySelector("#portfolio-chart-locked");
const portfolioChartApp = document.querySelector("#portfolio-chart-app");
const portfolioChartCaption = document.querySelector("#portfolio-chart-caption");
const portfolioChartSvg = document.querySelector("#portfolio-chart-svg");
const searchResults = document.querySelector("#search-results");
const quoteResults = document.querySelector("#quote-results");
const analyzerLocked = document.querySelector("#analyzer-locked");
const analyzeForm = document.querySelector("#analyze-form");
const scoreBox = document.querySelector("#score");
const scoreLabel = document.querySelector("#score-label");
const scoreComposite = document.querySelector("#score-composite");
const scoreDisclaimer = document.querySelector("#score-disclaimer");
const pillarList = document.querySelector("#pillar-list");
const watchlistPrompt = document.querySelector("#watchlist-prompt");
const watchPromptStatus = document.querySelector("#watch-prompt-status");
const watchlistLocked = document.querySelector("#watchlist-locked");
const watchlistApp = document.querySelector("#watchlist-app");
const watchBody = document.querySelector("#watch-body");
const watchStatus = document.querySelector("#watch-status");

const KEY_STORAGE = "si-stocktool-api-key";
const PIN_STORAGE = "si-stocktool-portfolio-pin";

let csrfToken = "";
let me = null;
let lastAnalysis = null;
let portfolioEditing = "";
let portfolioLabel = "";
let portfolioKey = null;
let portfolioRecordKdf = null;
let portfolioPlain = Object.create(null);
let portfolioSnapshot = null;
let chartRange = "day";
let seriesCache = { key: "", daily: null, intraday: null };

function setStatus(text) {
  connectionStatus.textContent = text;
}

function storedKey() {
  return sessionStorage.getItem(KEY_STORAGE) || "";
}

function isPro() {
  return Boolean(me && !me.blocked && (me.plan === "pro" || me.role === "admin"));
}

function stripeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    if (!/(^|\.)stripe\.com$/.test(url.hostname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

keyInput.value = storedKey();
keyInput.addEventListener("change", () => {
  const value = keyInput.value.trim();
  if (value) sessionStorage.setItem(KEY_STORAGE, value);
  else sessionStorage.removeItem(KEY_STORAGE);
});

document.querySelector("#clear-key").addEventListener("click", () => {
  keyInput.value = "";
  sessionStorage.removeItem(KEY_STORAGE);
  setStatus("Key cleared from this tab.");
});

async function api(path, { method = "GET", body, avKey = false } = {}) {
  const headers = { accept: "application/json" };
  const key = keyInput.value.trim();
  if (avKey && key) headers["x-api-key"] = key;
  if (body) headers["content-type"] = "application/json";
  if (csrfToken && method !== "GET" && method !== "HEAD") headers["x-csrf-token"] = csrfToken;
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.detail ? ` ${payload.detail}` : "";
    const error = new Error((payload.error || `Request failed (${response.status})`) + detail);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function addItem(list, text) {
  const item = document.createElement("li");
  item.textContent = text;
  list.appendChild(item);
}

function button(label, className) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (className) element.className = className;
  return element;
}

const tabButtons = [...document.querySelectorAll("#desk-tabs [role='tab']")];

function selectTab(id) {
  const available = tabButtons.filter((tab) => !tab.hidden);
  const target = available.find((tab) => tab.dataset.tab === id) || available[0];
  if (!target) return;
  for (const tab of tabButtons) {
    const selected = tab === target;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    if (panel) panel.hidden = !selected;
  }
  if (target.dataset.tab === "portfolio") loadPortfolio();
}

function setAdminTab(visible) {
  adminTab.hidden = !visible;
  adminPanel.hidden = !visible;
  if (!visible) {
    adminBody.replaceChildren();
    if (adminTab.getAttribute("aria-selected") === "true") selectTab("account");
  }
}

document.querySelector("#desk-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[role='tab']");
  if (!tab || tab.hidden) return;
  selectTab(tab.dataset.tab);
});

document.querySelector("#desk-tabs").addEventListener("keydown", (event) => {
  if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
  const tabs = tabButtons.filter((tab) => !tab.hidden);
  const current = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  if (current < 0) return;
  event.preventDefault();
  let next = current;
  if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
  if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = tabs.length - 1;
  tabs[next].focus();
  selectTab(tabs[next].dataset.tab);
});

document.querySelector("#connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Checking key…");
  try {
    const result = await api("/api/test-connection", { method: "POST", body: {}, avKey: true });
    const source = result.source === "env" ? "local env key" : "browser key";
    setStatus(`${result.message} Source: ${source}.`);
  } catch (error) {
    setStatus(error.message);
  }
});

function formatNumber(value) {
  return new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 6 }).format(value);
}

function portfolioMode() {
  return portfolioModeInput.value === "quantity" ? "quantity" : "percent";
}

function roundQuantity(value) {
  return Math.round(value * 1e6) / 1e6;
}

function clearPortfolioSecret() {
  portfolioKey = null;
  portfolioPlain = Object.create(null);
  portfolioRecordKdf = null;
  sessionStorage.removeItem(PIN_STORAGE);
  syncPinControls();
}

function syncPinControls() {
  const unlocked = Boolean(sessionStorage.getItem(PIN_STORAGE));
  portfolioPinLock.hidden = !unlocked;
  portfolioPinSubmit.textContent = unlocked ? "PIN controleren" : "PIN in dit tabblad zetten";
}

function syncChartGate() {
  const pro = Boolean(me) && isPro();
  portfolioChartLocked.hidden = !me || pro;
  portfolioChartApp.hidden = !pro;
}

function dutchPortfolioError(message) {
  const text = String(message || "");
  if (/more than 100%/.test(text)) return "Percentages zouden samen meer dan 100% zijn. Minder dan 100% mag wel.";
  if (/already in the portfolio/.test(text)) return "Die ticker staat al in de portefeuille.";
  if (/quantityCipher is required/.test(text)) return "Het aantal moet versleuteld zijn.";
  if (/plaintext quantity/.test(text) || /Share counts stay/.test(text)) return "Aantallen gaan niet leesbaar naar de server.";
  if (/kdf is required/.test(text)) return "Zet eerst een portefeuille-PIN in dit tabblad.";
  if (/salt does not match/.test(text)) return "De PIN hoort niet bij de bestaande cijfertekst.";
  if (/not in the portfolio/.test(text)) return "Die ticker staat niet in de portefeuille.";
  if (/limited to/.test(text)) return "Het maximum aantal posities is bereikt.";
  if (/percent must be/.test(text)) return "Het percentage moet groter zijn dan 0 en hoogstens 100.";
  if (/ticker is required/.test(text)) return "Vul een ticker in.";
  if (/Sign in required/.test(text)) return "Log eerst in.";
  if (/Pro plan required/.test(text)) return "De grafiek hoort bij Pro.";
  return text;
}

function syncPortfolioValueLabel() {
  const percent = portfolioMode() === "percent";
  portfolioValueLabel.textContent = percent ? "Percentage" : "Aantal";
  portfolioValue.placeholder = percent ? "25" : "10";
  if (percent) portfolioValue.max = "100";
  else portfolioValue.removeAttribute("max");
}

function resetPortfolioForm() {
  portfolioEditing = "";
  portfolioLabel = "";
  portfolioTicker.readOnly = false;
  portfolioLookup.disabled = false;
  portfolioTicker.value = "";
  portfolioModeInput.value = "percent";
  portfolioValue.value = "";
  portfolioSubmit.textContent = "Toevoegen";
  portfolioCancel.hidden = true;
  portfolioMatches.replaceChildren();
  syncPortfolioValueLabel();
}

function allocationText(allocation) {
  if (!allocation) return "";
  if (allocation.status === "complete") return "De percentages tellen op tot 100%.";
  if (allocation.status === "under") {
    return `De percentages tellen op tot ${Number(allocation.percentSum).toFixed(2)}%. De rest is niet ingevuld. 100% is niet verplicht.`;
  }
  if (allocation.status === "over") {
    return `De percentages tellen op tot ${Number(allocation.percentSum).toFixed(2)}%, meer dan 100%. Verlaag een percentage of verwijder een positie.`;
  }
  if (allocation.message) return "Dit zijn versleutelde aantallen. Ze worden niet als gewicht getoond.";
  return "";
}

function showAllocation(allocation) {
  const message = allocationText(allocation);
  portfolioAllocation.hidden = !message;
  portfolioAllocation.textContent = message;
  const warn = allocation?.status === "under" || allocation?.status === "over";
  portfolioAllocation.className = warn ? "callout" : "hint";
}

function amountText(holding) {
  if (holding.mode === "percent") return `${formatNumber(holding.percent)}%`;
  const shares = portfolioPlain[holding.ticker];
  if (typeof shares !== "number") return "Versleuteld";
  const text = formatNumber(shares);
  return shares === 1 ? `${text} aandeel` : `${text} aandelen`;
}

function renderPortfolio(payload, quotes) {
  showAllocation(payload.allocation);
  portfolioBody.replaceChildren();
  const holdings = payload.holdings || [];
  if (!holdings.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "Nog geen posities.";
    row.appendChild(cell);
    portfolioBody.appendChild(row);
    return;
  }
  for (const holding of holdings) {
    const row = document.createElement("tr");
    const quote = quotes[holding.ticker];
    const price = quote && !quote.error ? Number(quote.price) : Number.NaN;
    const shares = portfolioPlain[holding.ticker];
    const cells = [
      holding.ticker,
      holding.label || holding.ticker,
      holding.mode === "percent" ? "Percentage" : "Aantal",
      amountText(holding),
      Number.isFinite(price) ? String(quote.price) : "—",
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      row.appendChild(td);
    }
    const mark = document.createElement("td");
    if (holding.mode === "quantity" && typeof shares === "number" && Number.isFinite(price)) {
      mark.textContent = formatNumber(shares * price);
    } else {
      mark.textContent = "—";
      if (holding.mode === "percent") {
        mark.title = "Een percentage heeft hier geen geldbedrag, want daarvoor is een portefeuillewaarde nodig.";
      } else if (typeof shares !== "number") {
        mark.title = "Het aantal is versleuteld. Ontgrendel de PIN in dit tabblad.";
      }
    }
    row.appendChild(mark);
    const actions = document.createElement("td");
    actions.className = "actions";
    const edit = button("Bewerken", "secondary");
    edit.addEventListener("click", () => startPortfolioEdit(holding));
    const remove = button("Verwijderen", "danger");
    remove.addEventListener("click", () => removeHolding(holding.ticker));
    actions.append(edit, remove);
    row.appendChild(actions);
    portfolioBody.appendChild(row);
  }
}

function startPortfolioEdit(holding) {
  portfolioEditing = holding.ticker;
  portfolioLabel = "";
  portfolioTicker.value = holding.ticker;
  portfolioTicker.readOnly = true;
  portfolioLookup.disabled = true;
  portfolioModeInput.value = holding.mode === "quantity" ? "quantity" : "percent";
  if (holding.mode === "percent") portfolioValue.value = holding.percent;
  else if (typeof portfolioPlain[holding.ticker] === "number") portfolioValue.value = portfolioPlain[holding.ticker];
  else portfolioValue.value = "";
  portfolioSubmit.textContent = "Opslaan";
  portfolioCancel.hidden = false;
  portfolioMatches.replaceChildren();
  syncPortfolioValueLabel();
  portfolioStatus.textContent =
    holding.mode === "quantity" && typeof portfolioPlain[holding.ticker] !== "number"
      ? `Bewerken ${holding.ticker}. Ontgrendel de PIN om het aantal te zien.`
      : `Bewerken ${holding.ticker}.`;
  portfolioValue.focus();
}

async function quotesFor(tickers) {
  const quotes = Object.create(null);
  if (!tickers.length || !keyInput.value.trim()) return quotes;
  const errors = [];
  for (let index = 0; index < tickers.length; index += 20) {
    const batch = tickers.slice(index, index + 20);
    try {
      const quoted = await api("/api/quotes", { method: "POST", body: { tickers: batch }, avKey: true });
      batch.forEach((ticker, offset) => {
        if (quoted.quotes?.[offset]) quotes[ticker] = quoted.quotes[offset];
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length) portfolioStatus.textContent = `Posities staan opgeslagen. Koersen niet beschikbaar: ${errors[0]}`;
  return quotes;
}

async function unlockQuantities(holdings, kdf) {
  portfolioPlain = Object.create(null);
  portfolioRecordKdf = kdf || null;
  portfolioKey = null;
  const pin = sessionStorage.getItem(PIN_STORAGE) || "";
  if (!kdf || !pin) return;
  try {
    portfolioKey = await derivePortfolioKey(pin, kdf);
    for (const holding of holdings) {
      if (holding.mode !== "quantity" || !holding.quantityCipher) continue;
      portfolioPlain[holding.ticker] = await decryptQuantity(portfolioKey, holding.quantityCipher);
    }
    portfolioPinStatus.textContent = "PIN ontgrendelt de aantallen in dit tabblad. Ze gaan niet naar de server.";
  } catch {
    portfolioKey = null;
    portfolioPlain = Object.create(null);
    portfolioPinStatus.textContent = "PIN klopt niet. Zonder de juiste PIN zijn de aantallen niet te herstellen.";
  }
}

function chartHoldings() {
  return (portfolioSnapshot?.holdings || []).slice(0, 10).map((holding) => ({
    ticker: holding.ticker,
    mode: holding.mode,
    percent: holding.percent,
    quantity: holding.mode === "quantity" ? portfolioPlain[holding.ticker] : undefined,
  }));
}

function drawChart(points) {
  const svg = portfolioChartSvg;
  const ns = "http://www.w3.org/2000/svg";
  svg.replaceChildren();
  const width = 640;
  const height = 260;
  const pad = 28;
  if (!points.length) {
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", "24");
    text.setAttribute("y", "40");
    text.setAttribute("fill", "#5e564c");
    text.textContent = "Geen lijn voor deze periode.";
    svg.appendChild(text);
    return;
  }
  const values = points.map((point) => point.v);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const xAt = (index) => pad + (index / Math.max(points.length - 1, 1)) * (width - pad * 2);
  const yAt = (value) => height - pad - ((value - min) / (max - min)) * (height - pad * 2);
  const line = points.map((point, index) => `${index ? "L" : "M"}${xAt(index).toFixed(1)},${yAt(point.v).toFixed(1)}`).join(" ");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", line);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#1e4a38");
  path.setAttribute("stroke-width", "2.5");
  svg.appendChild(path);
  const label = document.createElementNS(ns, "text");
  label.setAttribute("x", String(pad));
  label.setAttribute("y", "20");
  label.setAttribute("fill", "#5e564c");
  label.setAttribute("font-size", "13");
  label.textContent = `${formatNumber(points[0].v)} → ${formatNumber(points[points.length - 1].v)}`;
  svg.appendChild(label);
  svg.setAttribute("aria-label", label.textContent);
}

function setChartRange(range) {
  chartRange = range;
  for (const button of document.querySelectorAll("#portfolio-ranges button")) {
    button.setAttribute("aria-pressed", button.dataset.range === range ? "true" : "false");
  }
}

async function loadSpan(span, tickers) {
  const result = await api("/api/series", { method: "POST", body: { tickers, span }, avKey: true });
  const map = Object.create(null);
  for (const row of result.series || []) {
    if (row.points) map[row.ticker] = row.points;
  }
  return map;
}

async function refreshChart() {
  syncChartGate();
  if (!me || !isPro()) return;
  const rows = chartHoldings();
  if (!keyInput.value.trim()) {
    portfolioChartCaption.textContent = "Plak een Alpha Vantage-sleutel bij Account. De grafiek gebruikt alleen die sleutel in deze browser.";
    drawChart([]);
    return;
  }
  const tickers = rows.map((row) => row.ticker);
  if (!tickers.length) {
    const built = buildSeries({ holdings: [], range: chartRange });
    portfolioChartCaption.textContent = built.caption;
    drawChart([]);
    return;
  }
  const cacheKey = tickers.join(",");
  if (seriesCache.key !== cacheKey) seriesCache = { key: cacheKey, daily: null, intraday: null };
  try {
    if (chartRange === "day" && !seriesCache.intraday) seriesCache.intraday = await loadSpan("intraday", tickers);
    if (chartRange !== "day" && !seriesCache.daily) seriesCache.daily = await loadSpan("daily", tickers);
  } catch (error) {
    portfolioChartCaption.textContent = dutchPortfolioError(error.message);
    drawChart([]);
    return;
  }
  const built = buildSeries({
    holdings: rows,
    daily: seriesCache.daily || {},
    intraday: seriesCache.intraday || {},
    range: chartRange,
  });
  const extra = (portfolioSnapshot?.holdings || []).length > 10 ? " De grafiek gebruikt de eerste 10 posities." : "";
  portfolioChartCaption.textContent = `${built.caption}${extra}`;
  drawChart(built.points);
}

async function loadPortfolio() {
  syncPinControls();
  syncChartGate();
  if (!me) {
    portfolioLocked.hidden = false;
    portfolioApp.hidden = true;
    portfolioBody.replaceChildren();
    portfolioAllocation.hidden = true;
    portfolioSnapshot = null;
    resetPortfolioForm();
    return;
  }
  portfolioLocked.hidden = true;
  portfolioApp.hidden = false;
  try {
    const result = await api("/api/portfolio");
    portfolioSnapshot = result;
    await unlockQuantities(result.holdings || [], result.kdf);
    const quotes = await quotesFor((result.holdings || []).map((holding) => holding.ticker));
    renderPortfolio(result, quotes);
    await refreshChart();
  } catch (error) {
    portfolioStatus.textContent = dutchPortfolioError(error.message);
  }
}

async function removeHolding(ticker) {
  portfolioStatus.textContent = "Bezig met verwijderen…";
  try {
    await api(`/api/portfolio/${encodeURIComponent(ticker)}`, { method: "DELETE" });
    if (portfolioEditing === ticker) resetPortfolioForm();
    portfolioStatus.textContent = `Verwijderd ${ticker}.`;
    seriesCache = { key: "", daily: null, intraday: null };
    await loadPortfolio();
  } catch (error) {
    portfolioStatus.textContent = dutchPortfolioError(error.message);
  }
}

function renderScore(result) {
  scoreBox.hidden = false;
  scoreLabel.textContent = `${result.mode === "replay" ? "Replay" : "Live"} · ${result.ticker} · ${result.label || ""}`;
  scoreComposite.textContent =
    result.composite == null ? "No composite — snapshot has no scored dimensions." : `Composite ${result.composite} / 100`;
  scoreComposite.className = "composite";
  scoreDisclaimer.textContent = result.disclaimer || "";
  pillarList.replaceChildren();
  for (const pillar of result.pillars || []) {
    const item = document.createElement("li");
    item.className = "pillar";
    const name = document.createElement("span");
    name.textContent = pillar.name;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.style.width = `${pillar.score == null ? 0 : pillar.score}%`;
    bar.appendChild(fill);
    const value = document.createElement("strong");
    value.textContent = pillar.score == null ? "—" : String(pillar.score);
    item.append(name, bar, value);
    item.title = pillar.note || "";
    pillarList.appendChild(item);
  }
  lastAnalysis = result;
  document.querySelector("#watch-note").value = "";
  watchPromptStatus.textContent = "";
  watchlistPrompt.hidden = false;
}

function showScoreError(message) {
  scoreBox.hidden = false;
  scoreLabel.textContent = message;
  scoreComposite.textContent = "";
  scoreDisclaimer.textContent = "";
  pillarList.replaceChildren();
  watchlistPrompt.hidden = true;
  lastAnalysis = null;
}

function renderUpgrade() {
  upgradeActions.replaceChildren();
  if (!me) {
    upgradeStatus.textContent = "Log in to upgrade.";
    return;
  }
  if (!upgradeStatus.dataset.sticky) upgradeStatus.textContent = "";
  if (me.plan === "pro" || me.role === "admin") {
    const label = document.createElement("p");
    label.textContent = me.plan === "pro" ? "Your plan is Pro." : "Admin accounts can use Pro features.";
    upgradeActions.appendChild(label);
  }
  if (me.plan !== "pro") {
    const upgrade = button("Upgrade to Pro");
    upgrade.addEventListener("click", () => startBilling("/api/billing/checkout"));
    upgradeActions.appendChild(upgrade);
  }
  if (me.hasBilling) {
    const portal = button("Manage billing", "secondary");
    portal.addEventListener("click", () => startBilling("/api/billing/portal"));
    upgradeActions.appendChild(portal);
  }
}

async function startBilling(path) {
  upgradeStatus.dataset.sticky = "1";
  upgradeStatus.textContent = "Opening Stripe…";
  try {
    const result = await api(path, { method: "POST", body: {} });
    const url = stripeUrl(result.url);
    if (!url) throw new Error("Stripe did not return a checkout link.");
    window.location.assign(url);
  } catch (error) {
    upgradeStatus.textContent = error.message;
  }
}

function renderAdmin(users) {
  adminBody.replaceChildren();
  for (const user of users || []) {
    const row = document.createElement("tr");
    for (const cell of [user.email, user.role, user.plan, user.blocked ? "Blocked" : "Active"]) {
      const td = document.createElement("td");
      td.textContent = cell;
      row.appendChild(td);
    }
    const actions = document.createElement("td");
    actions.className = "actions";
    const planButton = button(user.plan === "pro" ? "Set Free" : "Set Pro", "secondary");
    planButton.addEventListener("click", () => updateUser(user.id, { plan: user.plan === "pro" ? "free" : "pro" }));
    actions.appendChild(planButton);
    const blockButton = button(user.blocked ? "Unblock" : "Block", user.blocked ? "secondary" : "danger");
    if (me && user.id === me.id) blockButton.disabled = true;
    blockButton.addEventListener("click", () => updateUser(user.id, { blocked: !user.blocked }));
    actions.appendChild(blockButton);
    row.appendChild(actions);
    adminBody.appendChild(row);
  }
}

async function updateUser(id, body) {
  adminStatus.textContent = "Saving…";
  try {
    await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: "POST", body });
    adminStatus.textContent = "Saved.";
    await refreshSession();
  } catch (error) {
    adminStatus.textContent = error.message;
  }
}

async function loadAdmin() {
  if (!me || me.role !== "admin") {
    setAdminTab(false);
    return;
  }
  setAdminTab(true);
  try {
    const result = await api("/api/admin/users");
    renderAdmin(result.users);
  } catch (error) {
    adminStatus.textContent = error.message;
  }
}

function formatWhen(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function scoreText(value) {
  return value == null ? "—" : String(value);
}

function renderWatchlist(items) {
  watchBody.replaceChildren();
  if (!items?.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "No tickers saved yet.";
    row.appendChild(cell);
    watchBody.appendChild(row);
    return;
  }
  for (const item of items) {
    const row = document.createElement("tr");
    for (const cell of [
      item.ticker,
      item.label,
      scoreText(item.lastComposite),
      scoreText(item.previousComposite),
      formatWhen(item.lastRunAt),
      item.note || "",
    ]) {
      const td = document.createElement("td");
      td.textContent = cell;
      row.appendChild(td);
    }
    const actions = document.createElement("td");
    actions.className = "actions";
    const rescore = button("Re-score", "secondary");
    rescore.addEventListener("click", () => reanalyze({ ticker: item.ticker }));
    const remove = button("Remove", "danger");
    remove.addEventListener("click", () => removeTicker(item.ticker));
    actions.append(rescore, remove);
    row.appendChild(actions);
    watchBody.appendChild(row);
  }
}

async function loadWatchlist() {
  if (!isPro()) {
    watchlistLocked.hidden = false;
    watchlistApp.hidden = true;
    watchBody.replaceChildren();
    return;
  }
  watchlistLocked.hidden = true;
  watchlistApp.hidden = false;
  try {
    const result = await api("/api/watchlist");
    renderWatchlist(result.items);
  } catch (error) {
    watchStatus.textContent = error.message;
  }
}

async function removeTicker(ticker) {
  watchStatus.textContent = "Removing…";
  try {
    await api(`/api/watchlist/${encodeURIComponent(ticker)}`, { method: "DELETE" });
    watchStatus.textContent = `Removed ${ticker}.`;
    await loadWatchlist();
  } catch (error) {
    watchStatus.textContent = error.message;
  }
}

async function reanalyze(body) {
  watchStatus.textContent = "Re-scoring…";
  try {
    const result = await api("/api/watchlist/reanalyze", { method: "POST", body, avKey: true });
    const failed = (result.results || []).filter((row) => !row.ok);
    watchStatus.textContent = failed.length
      ? failed.map((row) => `${row.ticker}: ${row.error}`).join(" ")
      : "Re-score finished.";
    renderWatchlist(result.items);
  } catch (error) {
    watchStatus.textContent = error.message;
  }
}

function showAuthPage(which) {
  const signup = which === "signup";
  loginPage.hidden = signup;
  signupPage.hidden = !signup;
}

function applyAccess() {
  const signedIn = Boolean(me);
  authForms.hidden = signedIn;
  sessionPanel.hidden = !signedIn;
  if (!signedIn) {
    showAuthPage("login");
    accountStatus.textContent = "You are not signed in.";
  } else {
    const plan = me.plan === "pro" ? "Pro" : "Free";
    const role = me.role === "admin" ? " · admin" : "";
    accountStatus.textContent = `Signed in as ${me.email} · ${plan}${role}.`;
  }
  const allowed = isPro();
  analyzerLocked.hidden = allowed;
  analyzeForm.hidden = !allowed;
  if (!allowed) {
    scoreBox.hidden = true;
    watchlistPrompt.hidden = true;
  }
  renderUpgrade();
  syncChartGate();
}

async function refreshSession() {
  try {
    const result = await api("/api/auth/me");
    me = result.user;
    csrfToken = result.csrfToken || "";
  } catch {
    me = null;
    csrfToken = "";
    clearPortfolioSecret();
  }
  applyAccess();
  await loadAdmin();
  await loadWatchlist();
  await loadPortfolio();
}

async function submitAuth(path, email, password) {
  accountStatus.textContent = "Checking account…";
  try {
    const result = await api(path, { method: "POST", body: { email, password } });
    me = result.user;
    csrfToken = result.csrfToken || "";
    applyAccess();
    await loadAdmin();
    await loadWatchlist();
    await loadPortfolio();
  } catch (error) {
    accountStatus.textContent = error.message;
  }
}

document.querySelector("#login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth("/api/auth/login", document.querySelector("#login-email").value, document.querySelector("#login-password").value);
});

document.querySelector("#signup-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth(
    "/api/auth/signup",
    document.querySelector("#signup-email").value,
    document.querySelector("#signup-password").value,
  );
});

document.querySelector("#show-signup").addEventListener("click", () => {
  showAuthPage("signup");
  accountStatus.textContent = "Create a new account.";
});

document.querySelector("#show-login").addEventListener("click", () => {
  showAuthPage("login");
  accountStatus.textContent = "You are not signed in.";
});

document.querySelector("#logout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch (error) {
    accountStatus.textContent = error.message;
  }
  me = null;
  csrfToken = "";
  clearPortfolioSecret();
  applyAccess();
  setAdminTab(false);
  await loadWatchlist();
  await loadPortfolio();
});

document.querySelector("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const keywords = document.querySelector("#keywords").value.trim();
  searchResults.replaceChildren();
  try {
    const result = await api(`/api/search?keywords=${encodeURIComponent(keywords)}`, { avKey: true });
    if (!result.matches?.length) {
      addItem(searchResults, "No matches.");
      return;
    }
    for (const match of result.matches) {
      addItem(searchResults, `${match.symbol} · ${match.name} · ${match.region} ${match.currency}`.trim());
    }
  } catch (error) {
    addItem(searchResults, error.message);
  }
});

document.querySelector("#quote-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const tickers = document
    .querySelector("#tickers")
    .value.split(/[\s,]+/)
    .map((ticker) => ticker.trim())
    .filter(Boolean);
  quoteResults.replaceChildren();
  try {
    const result = await api("/api/quotes", { method: "POST", body: { tickers }, avKey: true });
    for (const quote of result.quotes || []) {
      if (quote.error) addItem(quoteResults, `${quote.ticker}: ${quote.error}`);
      else addItem(quoteResults, `${quote.ticker}: ${quote.price} (${quote.changePercent || "n/a"})`);
    }
  } catch (error) {
    addItem(quoteResults, error.message);
  }
});

async function analyze(replay) {
  const ticker = document.querySelector("#analyze-ticker").value.trim();
  try {
    const result = await api("/api/analyze", {
      method: "POST",
      body: { ticker, replay },
      avKey: true,
    });
    renderScore(result);
  } catch (error) {
    showScoreError(error.message);
  }
}

document.querySelector("#analyze-form").addEventListener("submit", (event) => {
  event.preventDefault();
  analyze(false);
});

document.querySelector("#replay").addEventListener("click", () => analyze(true));

document.querySelector("#watch-add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!lastAnalysis) return;
  watchPromptStatus.textContent = "Saving…";
  try {
    await api("/api/watchlist", {
      method: "POST",
      body: {
        ticker: lastAnalysis.ticker,
        label: String(lastAnalysis.label || lastAnalysis.ticker).slice(0, 80),
        composite: lastAnalysis.composite,
        note: document.querySelector("#watch-note").value,
      },
    });
    watchPromptStatus.textContent = `Saved ${lastAnalysis.ticker}.`;
    watchlistPrompt.hidden = true;
    await loadWatchlist();
  } catch (error) {
    watchPromptStatus.textContent = error.message;
  }
});

document.querySelector("#watch-skip").addEventListener("click", () => {
  watchlistPrompt.hidden = true;
});

document.querySelector("#reanalyze-all").addEventListener("click", () => reanalyze({ all: true }));

portfolioModeInput.addEventListener("change", syncPortfolioValueLabel);
portfolioTicker.addEventListener("input", () => {
  if (!portfolioEditing) portfolioLabel = "";
});

portfolioLookup.addEventListener("click", async () => {
  const keywords = portfolioTicker.value.trim();
  portfolioMatches.replaceChildren();
  if (!keywords) {
    portfolioStatus.textContent = "Vul een ticker of naam in om te zoeken.";
    return;
  }
  try {
    const result = await api(`/api/search?keywords=${encodeURIComponent(keywords)}`, { avKey: true });
    if (!result.matches?.length) {
      addItem(portfolioMatches, "Geen treffers.");
      return;
    }
    for (const match of result.matches) {
      const item = document.createElement("li");
      const choose = button(`${match.symbol} · ${match.name}`, "secondary");
      choose.addEventListener("click", () => {
        portfolioTicker.value = match.symbol;
        portfolioLabel = String(match.name || match.symbol).slice(0, 80);
        portfolioMatches.replaceChildren();
      });
      item.appendChild(choose);
      portfolioMatches.appendChild(item);
    }
  } catch (error) {
    addItem(portfolioMatches, error.message);
  }
});

portfolioCancel.addEventListener("click", () => {
  resetPortfolioForm();
  portfolioStatus.textContent = "";
});

document.querySelector("#portfolio-pin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = portfolioPinInput.value;
  if (pin.length < 8 || pin.length > 64) {
    portfolioPinStatus.textContent = "Kies een PIN van minstens 8 tekens. Die blijft alleen in dit tabblad.";
    return;
  }
  if (portfolioRecordKdf && (portfolioSnapshot?.holdings || []).some((holding) => holding.mode === "quantity")) {
    try {
      const key = await derivePortfolioKey(pin, portfolioRecordKdf);
      const sample = portfolioSnapshot.holdings.find((holding) => holding.mode === "quantity" && holding.quantityCipher);
      if (sample) await decryptQuantity(key, sample.quantityCipher);
      portfolioKey = key;
    } catch {
      portfolioPinStatus.textContent = "PIN klopt niet. Een vergeten PIN is niet te herstellen, ook niet met een wachtwoordreset.";
      return;
    }
  }
  sessionStorage.setItem(PIN_STORAGE, pin);
  portfolioPinInput.value = "";
  portfolioPinStatus.textContent = "PIN staat in dit tabblad. De server krijgt hem niet.";
  syncPinControls();
  await loadPortfolio();
});

portfolioPinLock.addEventListener("click", async () => {
  portfolioKey = null;
  portfolioPlain = Object.create(null);
  sessionStorage.removeItem(PIN_STORAGE);
  syncPinControls();
  portfolioPinStatus.textContent = "PIN gewist uit dit tabblad. De cijfertekst blijft staan en is zonder PIN niet leesbaar.";
  await loadPortfolio();
});

document.querySelector("#portfolio-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = portfolioMode();
  const value = Number(portfolioValue.value);
  if (!Number.isFinite(value) || value <= 0) {
    portfolioStatus.textContent = mode === "percent" ? "Vul een percentage groter dan 0 in." : "Vul een aantal groter dan 0 in.";
    return;
  }
  if (mode === "percent" && value > 100) {
    portfolioStatus.textContent = "Een positie kan niet meer dan 100% van de portefeuille zijn.";
    return;
  }
  const body = { mode };
  if (mode === "percent") body.percent = value;
  else {
    const pin = sessionStorage.getItem(PIN_STORAGE) || "";
    if (pin.length < 8) {
      portfolioStatus.textContent = "Zet eerst een portefeuille-PIN in dit tabblad. Het aantal wordt daarmee versleuteld.";
      portfolioPinInput.focus();
      return;
    }
    try {
      const kdf = portfolioRecordKdf || createKdf();
      if (!portfolioKey || !portfolioRecordKdf) portfolioKey = await derivePortfolioKey(pin, kdf);
      body.quantityCipher = await encryptQuantity(portfolioKey, roundQuantity(value));
      if (!portfolioRecordKdf) body.kdf = kdf;
    } catch {
      portfolioStatus.textContent = "Versleutelen is mislukt. Het aantal is niet verstuurd.";
      return;
    }
  }
  if (!portfolioEditing && portfolioLabel) body.label = portfolioLabel;
  const editing = portfolioEditing;
  if (!editing) body.ticker = portfolioTicker.value.trim();
  portfolioStatus.textContent = "Bezig met opslaan…";
  try {
    if (editing) await api(`/api/portfolio/${encodeURIComponent(editing)}`, { method: "PATCH", body });
    else await api("/api/portfolio", { method: "POST", body });
    const ticker = editing || body.ticker;
    resetPortfolioForm();
    portfolioStatus.textContent = `Opgeslagen ${String(ticker).toUpperCase()}.`;
    seriesCache = { key: "", daily: null, intraday: null };
    await loadPortfolio();
  } catch (error) {
    portfolioStatus.textContent = dutchPortfolioError(error.message);
  }
});

document.querySelector("#portfolio-ranges").addEventListener("click", (event) => {
  const rangeButton = event.target.closest("button[data-range]");
  if (!rangeButton) return;
  setChartRange(rangeButton.dataset.range);
  refreshChart();
});

syncPortfolioValueLabel();
syncPinControls();
syncChartGate();

const billing = new URLSearchParams(window.location.search).get("billing");
if (billing === "success") {
  upgradeStatus.dataset.sticky = "1";
  upgradeStatus.textContent = "Checkout returned. The plan updates after Stripe notifies this server. Reload if it still says Free.";
} else if (billing === "cancel") {
  upgradeStatus.dataset.sticky = "1";
  upgradeStatus.textContent = "Checkout was canceled. Your plan was not changed.";
}
if (billing) {
  const url = new URL(window.location.href);
  url.searchParams.delete("billing");
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}

refreshSession();
