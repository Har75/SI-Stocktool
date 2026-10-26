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
const bookBody = document.querySelector("#book-body");
const bookTotal = document.querySelector("#book-total");
const bookDisclaimer = document.querySelector("#book-disclaimer");
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

let csrfToken = "";
let me = null;
let lastAnalysis = null;

function money(value) {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(value);
}

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

function renderBook(book) {
  bookDisclaimer.textContent = book.disclaimer || "";
  bookBody.replaceChildren();
  let total = 0;
  for (const position of book.positions || []) {
    const value = Number(position.shares) * Number(position.markPerShareEur);
    total += value;
    const row = document.createElement("tr");
    for (const cell of [
      position.ticker,
      position.sampleName,
      String(position.shares),
      money(position.costPerShareEur),
      money(position.markPerShareEur),
      money(value),
    ]) {
      const td = document.createElement("td");
      td.textContent = cell;
      row.appendChild(td);
    }
    bookBody.appendChild(row);
  }
  bookTotal.textContent = money(total);
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
}

async function refreshSession() {
  try {
    const result = await api("/api/auth/me");
    me = result.user;
    csrfToken = result.csrfToken || "";
  } catch {
    me = null;
    csrfToken = "";
  }
  applyAccess();
  await loadAdmin();
  await loadWatchlist();
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
  applyAccess();
  setAdminTab(false);
  await loadWatchlist();
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

api("/api/demo-book")
  .then(renderBook)
  .catch((error) => {
    bookDisclaimer.textContent = error.message;
  });

refreshSession();
