// Herdr Ranch: an estimated cost for Codex and Antigravity conversations, from prices you set.
// Neither CLI records a cost, and prices change, so none are built in: put them in
// <app home>/data/herdr-ranch-agents/prices.json, US dollars per million tokens:
//   { "gpt-6.2-sol": { "input": 1.25, "cacheRead": 0.125, "output": 10 },
//     "gemini-4-neon": { "input": 2, "cacheRead": 0.5, "output": 12 } }
// A key matches a model whose name starts with it (lowercase, spaces as "-"): "gpt-6" covers
// every gpt-6 model, and the longest matching key wins. cacheRead defaults to input.
import { exec, appHome } from "herdr";

export const pricesFile = () => `${appHome()}/data/herdr-ranch-agents/prices.json`;

export async function loadPrices() {
  const r = await exec("cat", [pricesFile()]).catch(() => null);
  if (r?.code !== 0) return {};
  try { const p = JSON.parse(r.stdout); return p && typeof p === "object" && !Array.isArray(p) ? p : {}; } catch { return {}; }
}

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "-");

// The price for a model, or null: the longest key its name starts with.
export function priceFor(prices, model) {
  const m = norm(model);
  if (!m) return null;
  const key = Object.keys(prices ?? {}).filter((k) => k && m.startsWith(norm(k))).sort((a, b) => b.length - a.length)[0];
  const p = key ? prices[key] : null;
  return p && Number.isFinite(p.input) && Number.isFinite(p.output) ? p : null;
}

// Dollars for totals { input (new), cacheRead, output } at a price, or null without one.
export function costOf(totals, price) {
  if (!totals || !price) return null;
  const cache = Number.isFinite(price.cacheRead) ? price.cacheRead : price.input;
  return ((totals.input ?? 0) * price.input + (totals.cacheRead ?? 0) * cache + (totals.output ?? 0) * price.output) / 1e6;
}
