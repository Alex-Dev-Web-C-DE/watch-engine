// watch-engine — Cloudflare Worker
// Currency Watch + VAT Watch + Tariff Watch + Sanctions Watch
// Cron: daily 06:00 UTC

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
};

const COMPLIANCE_ENGINE_URL = "https://compliance-engine.boring-saas-infra.workers.dev";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ============ CURRENCY SOURCES ============

async function fetchNBU() {
  const r = await fetch("https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json");
  if (!r.ok) throw new Error("NBU HTTP " + r.status);
  const data = await r.json();
  const rates = {};
  for (const row of data) {
    rates[row.cc] = { rate: row.rate, name: row.txt, date: row.exchangedate };
  }
  return { source: "NBU", base: "UAH", rates, timestamp: new Date().toISOString() };
}

async function fetchECB() {
  const r = await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
  if (!r.ok) throw new Error("ECB HTTP " + r.status);
  const xml = await r.text();
  const rates = {};
  const re = /currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    rates[m[1]] = { rate: parseFloat(m[2]) };
  }
  const dateMatch = xml.match(/time=['"]([\d-]+)['"]/);
  return {
    source: "ECB",
    base: "EUR",
    rates,
    date: dateMatch ? dateMatch[1] : null,
    timestamp: new Date().toISOString(),
  };
}

async function fetchFrankfurter(base = "USD") {
  const r = await fetch(`https://api.frankfurter.app/latest?from=${base}`);
  if (!r.ok) throw new Error("Frankfurter HTTP " + r.status);
  const data = await r.json();
  return {
    source: "Frankfurter",
    base: data.base,
    date: data.date,
    rates: Object.fromEntries(
      Object.entries(data.rates).map(([k, v]) => [k, { rate: v }])
    ),
    timestamp: new Date().toISOString(),
  };
}

// ============ VAT SOURCES ============

const VAT_SNAPSHOT = {
  updated: "2026-10-08",
  countries: {
    AT: { standard: 20, reduced: [10, 13] },
    BE: { standard: 21, reduced: [6, 12] },
    BG: { standard: 20, reduced: [9] },
    HR: { standard: 25, reduced: [5, 13] },
    CY: { standard: 19, reduced: [5, 9] },
    CZ: { standard: 21, reduced: [12] },
    DK: { standard: 25, reduced: [] },
    EE: { standard: 22, reduced: [9] },
    FI: { standard: 25.5, reduced: [10, 14] },
    FR: { standard: 20, reduced: [2.1, 5.5, 10] },
    DE: { standard: 19, reduced: [7] },
    GR: { standard: 24, reduced: [6, 13] },
    HU: { standard: 27, reduced: [5, 18] },
    IE: { standard: 23, reduced: [9, 13.5] },
    IT: { standard: 22, reduced: [4, 5, 10] },
    LV: { standard: 21, reduced: [12] },
    LT: { standard: 21, reduced: [5, 9] },
    LU: { standard: 17, reduced: [3, 8] },
    MT: { standard: 18, reduced: [5, 7] },
    NL: { standard: 21, reduced: [9] },
    PL: { standard: 23, reduced: [5, 8] },
    PT: { standard: 23, reduced: [6, 13] },
    RO: { standard: 19, reduced: [5, 9] },
    SK: { standard: 20, reduced: [10] },
    SI: { standard: 22, reduced: [5, 9.5] },
    ES: { standard: 21, reduced: [10] },
    SE: { standard: 25, reduced: [6, 12] },
  },
};

function getVAT(countryCode) {
  const cc = countryCode.toUpperCase();
  const row = VAT_SNAPSHOT.countries[cc];
  if (!row) return null;
  return {
    country_code: cc,
    standard_rate: row.standard,
    reduced_rates: row.reduced,
    snapshot_updated: VAT_SNAPSHOT.updated,
    source: "EU Commission TEDB snapshot",
  };
}

// ============ TARIFF SOURCES ============

// Note: USITC / EU TARIC don't have free JSON APIs.
// Using static snapshot + manual updates via cron.
// For real-time tariff changes, integrate with paid providers (Avalara, Zonos).

const TARIFF_SNAPSHOT = {
  updated: "2026-10-08",
  source: "USITC HTS + EU TARIC snapshot",
  rates: {
    // HS code prefix → typical MFN duty rate (US)
    "8471": { description: "Computers and units", mfn_rate: 0.0, usmca: 0.0 },
    "8517": { description: "Telephones, smartphones", mfn_rate: 0.0, usmca: 0.0 },
    "8518": { description: "Audio equipment", mfn_rate: 4.9, usmca: 0.0 },
    "8528": { description: "Monitors, projectors", mfn_rate: 0.0, usmca: 0.0 },
    "8473": { description: "Computer parts", mfn_rate: 0.0, usmca: 0.0 },
    "6109": { description: "T-shirts (cotton)", mfn_rate: 16.5, usmca: 0.0 },
    "6203": { description: "Men's suits, trousers", mfn_rate: 16.6, usmca: 0.0 },
    "6402": { description: "Footwear (rubber/plastic)", mfn_rate: 6.0, usmca: 0.0 },
    "6403": { description: "Footwear (leather)", mfn_rate: 8.5, usmca: 0.0 },
    "9401": { description: "Seats, chairs", mfn_rate: 0.0, usmca: 0.0 },
    "9403": { description: "Furniture", mfn_rate: 0.0, usmca: 0.0 },
    "0901": { description: "Coffee", mfn_rate: 0.0, usmca: 0.0 },
    "0902": { description: "Tea", mfn_rate: 0.0, usmca: 0.0 },
    "1509": { description: "Olive oil", mfn_rate: 3.4, usmca: 0.0 },
    "2203": { description: "Beer", mfn_rate: 3.0, usmca: 0.0 },
    "2204": { description: "Wine", mfn_rate: 6.3, usmca: 0.0 },
    "2208": { description: "Spirits", mfn_rate: 0.0, usmca: 0.0 },
    "1806": { description: "Chocolate", mfn_rate: 5.6, usmca: 0.0 },
    "1902": { description: "Pasta", mfn_rate: 6.4, usmca: 0.0 },
    "9503": { description: "Toys", mfn_rate: 0.0, usmca: 0.0 },
    "9504": { description: "Video game consoles", mfn_rate: 0.0, usmca: 0.0 },
    "9506": { description: "Sports equipment", mfn_rate: 3.1, usmca: 0.0 },
    "8467": { description: "Hand tools with motor", mfn_rate: 2.8, usmca: 0.0 },
    "8205": { description: "Hand tools", mfn_rate: 6.2, usmca: 0.0 },
    "8204": { description: "Wrenches", mfn_rate: 9.0, usmca: 0.0 },
    "8424": { description: "Sprayers, extinguishers", mfn_rate: 2.4, usmca: 0.0 },
    "8414": { description: "Pumps, compressors", mfn_rate: 2.4, usmca: 0.0 },
    "8516": { description: "Electric heaters, ovens", mfn_rate: 2.7, usmca: 0.0 },
    "8508": { description: "Vacuum cleaners", mfn_rate: 2.7, usmca: 0.0 },
    "8415": { description: "Air conditioners", mfn_rate: 1.4, usmca: 0.0 },
    "8418": { description: "Refrigerators", mfn_rate: 1.4, usmca: 0.0 },
    "8450": { description: "Washing machines", mfn_rate: 1.4, usmca: 0.0 },
    "8422": { description: "Dishwashers", mfn_rate: 1.4, usmca: 0.0 },
    "3304": { description: "Cosmetics", mfn_rate: 4.9, usmca: 0.0 },
    "3305": { description: "Hair products", mfn_rate: 4.9, usmca: 0.0 },
    "3303": { description: "Perfumes", mfn_rate: 5.4, usmca: 0.0 },
  },
};

function getTariff(hsCodePrefix) {
  const prefix = String(hsCodePrefix || "").trim().slice(0, 4);
  const row = TARIFF_SNAPSHOT.rates[prefix];
  if (!row) return null;
  return {
    hs_prefix: prefix,
    description: row.description,
    mfn_rate_pct: row.mfn_rate,
    usmca_rate_pct: row.usmca,
    snapshot_updated: TARIFF_SNAPSHOT.updated,
    source: TARIFF_SNAPSHOT.source,
  };
}

// ============ WATCH STORAGE (KV) ============

async function saveWatch(env, watch) {
  const id = watch.id || crypto.randomUUID();
  watch.id = id;
  watch.created_at = watch.created_at || new Date().toISOString();
  await env.WATCH_KV.put(`watch:${id}`, JSON.stringify(watch));
  const indexRaw = await env.WATCH_KV.get("watch:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.includes(id)) {
    index.push(id);
    await env.WATCH_KV.put("watch:index", JSON.stringify(index));
  }
  return watch;
}

async function getWatch(env, id) {
  const raw = await env.WATCH_KV.get(`watch:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function listWatches(env) {
  const indexRaw = await env.WATCH_KV.get("watch:index");
  if (!indexRaw) return [];
  const ids = JSON.parse(indexRaw);
  const out = [];
  for (const id of ids) {
    const w = await getWatch(env, id);
    if (w) out.push(w);
  }
  return out;
}

async function deleteWatch(env, id) {
  await env.WATCH_KV.delete(`watch:${id}`);
  const indexRaw = await env.WATCH_KV.get("watch:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const next = index.filter(x => x !== id);
  await env.WATCH_KV.put("watch:index", JSON.stringify(next));
}

// ============ SNAPSHOT STORAGE for change detection ============

async function getSnapshot(env, key) {
  const raw = await env.WATCH_KV.get(`snap:${key}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveSnapshot(env, key, value) {
  await env.WATCH_KV.put(`snap:${key}`, JSON.stringify(value));
}

// ============ SANCTIONS CHECK (via compliance-engine) ============

async function checkSanctions(entity) {
  const url = COMPLIANCE_ENGINE_URL + "/check/sanctions?q=" + encodeURIComponent(entity);
  const r = await fetch(url);
  if (!r.ok) throw new Error("Compliance engine HTTP " + r.status);
  return await r.json();
}

// ============ CRON HANDLER ============

async function runCron(env, ctx) {
  const ts = new Date().toISOString();
  const results = { ts, currency: null, vat: null, tariff: null, sanctions: null, alerts: [] };

  // 1. Currency: pull NBU
  try {
    const nbu = await fetchNBU();
    const prev = await getSnapshot(env, "currency:NBU");
    if (prev) {
      for (const [cc, cur] of Object.entries(nbu.rates)) {
        const old = prev.rates[cc];
        if (old && Math.abs(old.rate - cur.rate) / old.rate > 0.005) {
          results.alerts.push({
            type: "CURRENCY_CHANGE",
            source: "NBU",
            currency: cc,
            from: old.rate,
            to: cur.rate,
            change_pct: ((cur.rate - old.rate) / old.rate * 100).toFixed(2),
            ts,
          });
        }
      }
    }
    await saveSnapshot(env, "currency:NBU", nbu);
    results.currency = { ok: true, rates_count: Object.keys(nbu.rates).length };
  } catch (e) {
    results.currency = { ok: false, error: String(e) };
  }

  try {
    const fr = await fetchFrankfurter("USD");
    await saveSnapshot(env, "currency:FrankfurterUSD", fr);
  } catch (e) {
    results.currency_fr = { ok: false, error: String(e) };
  }

  // 2. VAT
  const prevVAT = await getSnapshot(env, "vat:snapshot");
  if (prevVAT && prevVAT.updated !== VAT_SNAPSHOT.updated) {
    for (const [cc, cur] of Object.entries(VAT_SNAPSHOT.countries)) {
      const old = prevVAT.countries[cc];
      if (old && old.standard !== cur.standard) {
        results.alerts.push({
          type: "VAT_CHANGE",
          country: cc,
          from: old.standard + "%",
          to: cur.standard + "%",
          ts,
        });
      }
    }
  }
  await saveSnapshot(env, "vat:snapshot", VAT_SNAPSHOT);
  results.vat = { ok: true, countries: Object.keys(VAT_SNAPSHOT.countries).length };

  // 3. Tariff: check snapshot version
  const prevTariff = await getSnapshot(env, "tariff:snapshot");
  if (prevTariff && prevTariff.updated !== TARIFF_SNAPSHOT.updated) {
    results.alerts.push({
      type: "TARIFF_SNAPSHOT_UPDATE",
      from: prevTariff.updated,
      to: TARIFF_SNAPSHOT.updated,
      ts,
    });
  }
  await saveSnapshot(env, "tariff:snapshot", TARIFF_SNAPSHOT);
  results.tariff = { ok: true, hs_prefixes: Object.keys(TARIFF_SNAPSHOT.rates).length };

  // 4. Sanctions: check all "sanctions" type watches
  try {
    const watches = await listWatches(env);
    const sanctionsWatches = watches.filter(w => w.type === "sanctions" && w.target);
    let sanctionsChecked = 0;
    let sanctionsHits = 0;

    for (const w of sanctionsWatches) {
      sanctionsChecked++;
      try {
        const data = await checkSanctions(w.target);
        const status = data.status || "UNKNOWN";
        const prevKey = `sanctions:${w.target.toLowerCase()}`;
        const prev = await getSnapshot(env, prevKey);

        if (prev && prev.status !== status) {
          results.alerts.push({
            type: "SANCTIONS_CHANGE",
            target: w.target,
            from: prev.status,
            to: status,
            matches: data.total_matches || 0,
            ts,
          });
          sanctionsHits++;
        }
        await saveSnapshot(env, prevKey, { status, total_matches: data.total_matches || 0 });
      } catch (e) {
        results.alerts.push({
          type: "SANCTIONS_ERROR",
          target: w.target,
          error: String(e),
          ts,
        });
      }
    }
    results.sanctions = { ok: true, checked: sanctionsChecked, hits: sanctionsHits };
  } catch (e) {
    results.sanctions = { ok: false, error: String(e) };
  }

  // Persist run log
  await env.WATCH_KV.put(`run:${ts}`, JSON.stringify(results));
  return results;
}

// ============ ROUTER ============

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      if (path === "/health" || path === "/") {
        return json({
          status: "healthy",
          service: "watch-engine",
          version: "1.1.0",
          endpoints: [
            "/currency/nbu",
            "/currency/frankfurter",
            "/vat/:country",
            "/tariff/:hsCode",
            "/watch/list",
            "/watch/create",
            "/watch/:id",
            "/cron/run",
          ],
          timestamp: new Date().toISOString(),
        });
      }

      // -------- Currency --------
      if (path === "/currency/nbu") {
        const data = await fetchNBU();
        return json(data);
      }
      if (path === "/currency/frankfurter") {
        const base = url.searchParams.get("base") || "USD";
        const data = await fetchFrankfurter(base);
        return json(data);
      }

      // -------- VAT --------
      if (path.startsWith("/vat/")) {
        const cc = path.slice("/vat/".length);
        const v = getVAT(cc);
        if (!v) return json({ error: "Unknown country: " + cc }, 404);
        return json(v);
      }
      if (path === "/vat") {
        return json({ countries: VAT_SNAPSHOT.countries, updated: VAT_SNAPSHOT.updated });
      }

      // -------- Tariff --------
      if (path.startsWith("/tariff/")) {
        const hs = path.slice("/tariff/".length);
        const t = getTariff(hs);
        if (!t) return json({ error: "Unknown HS prefix: " + hs }, 404);
        return json(t);
      }
      if (path === "/tariff") {
        return json({ rates: TARIFF_SNAPSHOT.rates, updated: TARIFF_SNAPSHOT.updated });
      }

      // -------- Watches --------
      if (path === "/watch/list") {
        const list = await listWatches(env);
        return json({ count: list.length, watches: list });
      }

      if (path === "/watch/create" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || !body.type) return json({ error: "Body must be {type, target, webhook?}" }, 400);
        const watch = await saveWatch(env, {
          type: body.type,
          target: body.target || null,
          webhook: body.webhook || null,
        });
        return json({ ok: true, watch });
      }

      if (path.startsWith("/watch/") && request.method === "DELETE") {
        const id = path.slice("/watch/".length);
        await deleteWatch(env, id);
        return json({ ok: true, id });
      }

      if (path.startsWith("/watch/")) {
        const id = path.slice("/watch/".length);
        const w = await getWatch(env, id);
        if (!w) return json({ error: "Not found" }, 404);
        return json(w);
      }

      // -------- Manual cron trigger --------
      if (path === "/cron/run") {
        const result = await runCron(env, ctx);
        return json(result);
      }

      return json({ error: "Not found", path }, 404);
    } catch (err) {
      return json({ error: "Internal error", message: String(err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, ctx));
  },
};