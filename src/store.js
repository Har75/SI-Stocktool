import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function emptyState() {
  return { users: [], sessions: [], watchlists: Object.create(null), portfolios: Object.create(null) };
}

function copyUserMap(source) {
  const out = Object.create(null);
  if (!source || typeof source !== "object" || Array.isArray(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (!USER_ID.test(key) || !Array.isArray(value)) continue;
    out[key] = value.map((item) => ({ ...item }));
  }
  return out;
}

function copyHolding(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const ticker = typeof item.ticker === "string" ? item.ticker : "";
  const mode = item.mode === "quantity" || item.mode === "percent" ? item.mode : "";
  if (!ticker || !mode) return null;
  const holding = {
    ticker,
    label: typeof item.label === "string" ? item.label : ticker,
    mode,
    percent: mode === "percent" ? (item.percent ?? null) : null,
    quantityCipher: null,
  };
  if (mode === "quantity" && item.quantityCipher && typeof item.quantityCipher === "object") {
    holding.quantityCipher = {
      v: item.quantityCipher.v,
      iv: item.quantityCipher.iv,
      ct: item.quantityCipher.ct,
    };
  }
  return holding;
}

function copyPortfolioRecord(value) {
  const source = Array.isArray(value) ? { kdf: null, holdings: value } : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) return { kdf: null, holdings: [] };
  const kdf =
    source.kdf && typeof source.kdf === "object"
      ? {
          v: source.kdf.v,
          hash: source.kdf.hash,
          iterations: source.kdf.iterations,
          salt: source.kdf.salt,
        }
      : null;
  const holdings = [];
  if (Array.isArray(source.holdings)) {
    for (const item of source.holdings) {
      const holding = copyHolding(item);
      if (holding) holdings.push(holding);
    }
  }
  return { kdf, holdings };
}

function copyPortfolios(source) {
  const out = Object.create(null);
  if (!source || typeof source !== "object" || Array.isArray(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (!USER_ID.test(key)) continue;
    out[key] = copyPortfolioRecord(value);
  }
  return out;
}

export function copyState(state) {
  return {
    users: (state.users || []).map((user) => ({ ...user })),
    sessions: (state.sessions || []).map((session) => ({ ...session })),
    watchlists: copyUserMap(state.watchlists),
    portfolios: copyPortfolios(state.portfolios),
  };
}

function sanitizeState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error("store-corrupt");
    error.code = "STORE_CORRUPT";
    throw error;
  }
  if (!Array.isArray(parsed.users) || !Array.isArray(parsed.sessions)) {
    const error = new Error("store-corrupt");
    error.code = "STORE_CORRUPT";
    throw error;
  }
  return {
    users: parsed.users.map((user) => ({ ...user })),
    sessions: parsed.sessions.map((session) => ({ ...session })),
    watchlists: copyUserMap(parsed.watchlists),
    portfolios: copyPortfolios(parsed.portfolios),
  };
}

export class MemoryStore {
  constructor(initial) {
    this.state = initial ? copyState(initial) : emptyState();
    this.ready = Promise.resolve();
    this.chain = Promise.resolve();
  }

  read() {
    return this.chain.then(() => copyState(this.state));
  }

  update(mutator) {
    const run = this.chain.then(async () => {
      const draft = copyState(this.state);
      const result = await mutator(draft);
      await this.persist(draft);
      this.state = draft;
      return result;
    });
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async persist() {}
}

export class FileStore extends MemoryStore {
  constructor(dir) {
    super();
    this.file = join(resolve(String(dir)), "store.json");
    this.ready = this.#load();
    this.chain = this.ready.then(() => {});
  }

  async #load() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const text = await readFile(this.file, "utf8");
      this.state = sanitizeState(JSON.parse(text));
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.state = emptyState();
        await this.persist(this.state);
        return;
      }
      throw error;
    }
  }

  async persist(state) {
    const json = `${JSON.stringify(state)}\n`;
    JSON.parse(json);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, json, { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }
}

export function openStore(dir) {
  if (!dir) return new MemoryStore();
  return new FileStore(dir);
}
