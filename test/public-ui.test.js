import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

function between(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(start !== -1 && end !== -1, `${startMarker} .. ${endMarker}`);
  return html.slice(start, end);
}

test("desk sections are separate tabs", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(dupes, []);

  const labels = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1].trim());
  assert.deepEqual(labels, ["Account", "Portfolio", "Search", "Quotes", "Analyzer", "Watchlist", "Admin"]);

  const adminButton = html.match(/<button[^>]*id="tab-admin"[^>]*>/);
  assert.ok(adminButton);
  assert.match(adminButton[0], /\shidden(?:\s|=|>)/);

  const account = between('id="view-account"', 'id="view-portfolio"');
  for (const id of ["login-form", "signup-form", "logout", "upgrade-actions", "connection-form", "api-key"]) {
    assert.match(account, new RegExp(`id="${id}"`));
  }
  assert.match(account, /New account opens a separate sign-up page/);
  assert.match(account, /id="login-page"/);
  assert.match(account, /id="signup-page"[^>]*hidden/);
  assert.match(account, /id="show-signup"/);
  assert.match(account, /id="show-login"/);
  const loginPage = between('id="login-page"', 'id="signup-page"');
  assert.match(loginPage, /id="login-form"/);
  assert.match(loginPage, />Log in</);
  assert.match(loginPage, />New account</);
  assert.doesNotMatch(loginPage, /id="signup-form"/);
  assert.match(account, /Pro is required for Stock Analyzer/);
  assert.match(account, /Paste an Alpha Vantage key/);
  assert.doesNotMatch(account, /id="admin-panel"/);
  assert.doesNotMatch(account, /id="api-key"[^>]*\svalue=/);

  const portfolio = between('id="view-portfolio"', 'id="view-search"');
  assert.match(portfolio, /id="portfolio-body"/);
  assert.match(portfolio, /id="portfolio-form"/);
  assert.match(portfolio, /id="portfolio-pin-input"/);
  assert.match(portfolio, /herstelsleutel/);
  assert.match(portfolio, /<option value="percent" selected>Percentage<\/option>/);
  const ranges = [...portfolio.matchAll(/<button[^>]*data-range="[^"]+"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]);
  assert.deepEqual(ranges, ["Vandaag", "Laatste week", "Laatste maand", "Laatste 3 maanden", "Laatste 6 maanden"]);
  assert.match(html, /type="module"\s+src="\/app.js"/);

  assert.match(between('id="view-search"', 'id="view-quotes"'), /id="search-form"/);
  assert.match(between('id="view-quotes"', 'id="view-analyzer"'), /at most 20 tickers/);

  const analyzer = between('id="view-analyzer"', 'id="view-watchlist"');
  assert.match(analyzer, /id="analyzer-locked"/);
  assert.match(analyzer, /id="analyze-form"/);
  assert.match(analyzer, /id="watchlist-prompt"/);
  assert.match(analyzer, /Add to watchlist\?/);

  const watchlist = between('id="view-watchlist"', 'id="view-admin"');
  assert.match(watchlist, /id="watchlist-locked"/);
  assert.match(watchlist, /id="watchlist-app"/);

  const admin = between('id="view-admin"', "</main>");
  assert.match(admin, /id="admin-panel"/);
  assert.match(admin, /id="admin-body"/);
});

test("the client does not embed a shared Alpha Vantage key", () => {
  const client = `${html}\n${app}`;
  assert.doesNotMatch(client, /ALPHA_VANTAGE_API_KEY\s*[:=]\s*["'][^"']+["']/);
  assert.doesNotMatch(html, /<input[^>]*id="api-key"[^>]*value=/);
  assert.match(app, /sessionStorage\.getItem\(KEY_STORAGE\)/);
  assert.match(app, /headers\["x-api-key"\] = key/);
  assert.match(app, /quantityCipher/);
  assert.doesNotMatch(app, /body\.quantity\s*=/);
  assert.match(app, /PIN_STORAGE/);
  assert.match(app, /setAdminTab\(false\)/);
  assert.match(app, /setAdminTab\(true\)/);
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
});
