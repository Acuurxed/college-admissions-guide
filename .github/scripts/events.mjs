// Event collector. Runs daily in GitHub Actions with a real browser, because most admissions
// calendars only render inside one. Opens each school's official visit/events page (from data/live.json),
// reads only explicitly dated events (structured data, <time> elements, or text with a full date
// including the year) and writes data/events.json. Nothing is guessed: no year, no event.
import fs from "node:fs";
import { chromium } from "playwright";
const live = JSON.parse(fs.readFileSync("data/live.json", "utf8"));
const OUT = "data/events.json";
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { schools: {} };
const only = (process.env.EVENTS_ONLY || "").split(",").map(s => s.trim()).filter(Boolean);
const targets = [];
for (const [id, r] of Object.entries(live.research || {})) {
  if (only.length && !only.includes(id)) continue;
  const e = r.events || {}; const urls = [...new Set([e.events_page_url, e.info_session_url].filter(u => typeof u === "string" && /^https:\/\//.test(u)))];
  if (urls.length) targets.push({ id, urls: urls.slice(0, 2) });
}
const today = new Date().toISOString().slice(0, 10), limit = new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10);
function extract() {
  const MON = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const FULL = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i;
  const TIME = /\b(\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?))(?:\s?(?:-|to|–)\s?(\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)))?/i;
  const clean = t => String(t || "").replace(/\s+/g, " ").trim();
  const out = [], push = (date, title, time, url, how) => { title = clean(title).slice(0, 140); if (/^\d{4}-\d{2}-\d{2}$/.test(date) && title.length >= 4) out.push({ date, title, time: clean(time).slice(0, 40), url: url || "", how }); };
  // 1. schema.org Event structured data
  const walk = o => { if (!o || typeof o !== "object") return; if (Array.isArray(o)) return o.forEach(walk); const t = [].concat(o["@type"] || []); if (t.some(x => /Event$/.test(x)) && o.startDate && o.name) { const m = String(o.startDate).match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/); if (m) push(m[1], o.name, m[2] || "", typeof o.url === "string" ? o.url : "", "structured"); } Object.values(o).forEach(v => { if (v && typeof v === "object") walk(v); }); };
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => { try { walk(JSON.parse(s.textContent)); } catch (e) { } });
  // 2. <time datetime="..."> inside an item that has a heading or link
  document.querySelectorAll("time[datetime]").forEach(t => { const m = (t.getAttribute("datetime") || "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/); if (!m) return; const box = t.closest("article,li,tr,[class*=event],[class*=Event],[class*=card]") || t.parentElement; if (!box) return; const h = box.querySelector("h1,h2,h3,h4,h5,a"); const a = box.querySelector("a[href]"); if (h) push(m[1], h.textContent, m[2] || "", a ? a.href : "", "time"); });
  // 3. list items, rows and links whose own text carries a full date with the year
  document.querySelectorAll("li,tr,a,article,[class*=event],[class*=Event]").forEach(el => { const tx = clean(el.innerText); if (tx.length < 12 || tx.length > 260) return; const m = tx.match(FULL); if (!m) return; if ((tx.match(new RegExp(FULL.source, "gi")) || []).length > 2) return;
    const mo = MON[m[1].toLowerCase().replace(".", "")]; const date = `${m[3]}-${String(mo).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`; const tm = tx.match(TIME);
    let title = clean(tx.replace(new RegExp(FULL.source, "gi"), " ").replace(TIME, " ").replace(/\b(Mon|Tues?|Wed(nes)?|Thu(rs)?|Fri|Sat(ur)?|Sun)(day)?\b,?/gi, " ").replace(/\b(at|from|on|register|registration|sign up|learn more|details|view event|[ECMP][SD]?T)\b/gi, " ").replace(/^[\s,|:\-–]+|[\s,|:\-–]+$/g, ""));
    const h = el.querySelector && el.querySelector("h2,h3,h4,h5,strong,b"); if (h && clean(h.textContent).length >= 4) title = clean(h.textContent);
    const a = el.tagName === "A" ? el : el.querySelector && el.querySelector("a[href]"); push(date, title, tm ? tm[0] : "", a ? a.href : "", "text"); });
  return out;
}
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (compatible; AdmissaraEvents/1.0; +https://admissara.com/)", locale: "en-US", timezoneId: "America/New_York" });
await ctx.route("**/*", r => (/^(image|media|font)$/.test(r.request().resourceType()) ? r.abort() : r.continue()));
const result = { as_of: new Date().toISOString(), schools: {} }; const log = [];
async function visit(t) {
  const found = []; let ok = false;
  for (const url of t.urls) {
    const page = await ctx.newPage();
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => { }); await page.waitForTimeout(1500);
      if (process.env.EVENTS_DEBUG) { const resp = await page.evaluate(() => { const t = document.body ? document.body.innerText : ""; return { title: document.title.slice(0, 60), len: t.length, full: (t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+20\d{2}/g) || []).slice(0, 4), partial: (t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/g) || []).length, ld: document.querySelectorAll('script[type="application/ld+json"]').length, time: document.querySelectorAll("time[datetime]").length, iframes: [...document.querySelectorAll("iframe")].map(f => (f.src || "").slice(0, 70)).slice(0, 4), cal: [...document.querySelectorAll("a[href]")].map(a => a.href).filter(h => /calendar|events|register|portal|visit|slate|apply\./i.test(h)).slice(0, 6) }; }).catch(e => ({ err: e.message })); console.log("DEBUG", t.id, url, JSON.stringify(resp)); }
      for (const f of page.frames()) { try { for (const e of await f.evaluate(extract)) found.push({ ...e, url: /^https:\/\//.test(e.url) ? e.url : url, page: url }); } catch (e) { } } ok = true;
    } catch (e) { log.push(`${t.id} ${url} ${String(e.message).split("\n")[0].slice(0, 80)}`); } finally { await page.close(); }
  }
  const seen = new Set(); const rank = { structured: 0, time: 1, text: 2 };
  const list = found.filter(e => e.date >= today && e.date <= limit && !/deadline|due date|application due/i.test(e.title)).sort((a, b) => a.date.localeCompare(b.date) || rank[a.how] - rank[b.how])
    .filter(e => { const k = e.date + "|" + e.title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30)
    .map(e => ({ date: e.date, title: e.title, time: e.time, url: e.url, source: e.page }));
  // a page that failed to load keeps yesterday's still-future events instead of dropping them
  result.schools[t.id] = ok ? list : (prev.schools[t.id] || []).filter(e => e.date >= today);
}
let i = 0; await Promise.all(Array.from({ length: 4 }, async () => { while (i < targets.length) await visit(targets[i++]); }));
await browser.close();
for (const k of Object.keys(result.schools)) if (!result.schools[k].length) delete result.schools[k];
const n = Object.values(result.schools).reduce((a, b) => a + b.length, 0);
console.log(`visited ${targets.length} schools, ${Object.keys(result.schools).length} with dated events, ${n} events, ${log.length} page errors`); if (log.length) console.log(log.slice(0, 40).join("\n"));
const same = JSON.stringify(prev.schools || {}) === JSON.stringify(result.schools);
if (!same) fs.writeFileSync(OUT, JSON.stringify(result));
console.log(same ? "no change" : "events.json updated");
