const keyInput = document.querySelector("#api-key");
const connectionStatus = document.querySelector("#connection-status");
const bookBody = document.querySelector("#book-body");
const bookTotal = document.querySelector("#book-total");
const bookDisclaimer = document.querySelector("#book-disclaimer");
const searchResults = document.querySelector("#search-results");
const quoteResults = document.querySelector("#quote-results");
const scoreBox = document.querySelector("#score");
const scoreLabel = document.querySelector("#score-label");
const scoreComposite = document.querySelector("#score-composite");
const scoreDisclaimer = document.querySelector("#score-disclaimer");
const pillarList = document.querySelector("#pillar-list");

const KEY_STORAGE = "si-stocktool-api-key";

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

async function api(path, { method = "GET", body } = {}) {
  const headers = { accept: "application/json" };
  const key = keyInput.value.trim();
  if (key) headers["x-api-key"] = key;
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.detail ? ` ${payload.detail}` : "";
    throw new Error((payload.error || `Request failed (${response.status})`) + detail);
  }
  return payload;
}

function addItem(list, text) {
  const item = document.createElement("li");
  item.textContent = text;
  list.appendChild(item);
}

document.querySelector("#connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Checking key…");
  try {
    const result = await api("/api/test-connection", { method: "POST", body: {} });
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
}

document.querySelector("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const keywords = document.querySelector("#keywords").value.trim();
  searchResults.replaceChildren();
  try {
    const result = await api(`/api/search?keywords=${encodeURIComponent(keywords)}`);
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
    const result = await api("/api/quotes", { method: "POST", body: { tickers } });
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
    });
    renderScore(result);
  } catch (error) {
    scoreBox.hidden = false;
    scoreLabel.textContent = error.message;
    scoreComposite.textContent = "";
    scoreDisclaimer.textContent = "";
    pillarList.replaceChildren();
  }
}

document.querySelector("#analyze-form").addEventListener("submit", (event) => {
  event.preventDefault();
  analyze(false);
});

document.querySelector("#replay").addEventListener("click", () => analyze(true));

api("/api/demo-book")
  .then(renderBook)
  .catch((error) => {
    bookDisclaimer.textContent = error.message;
  });
