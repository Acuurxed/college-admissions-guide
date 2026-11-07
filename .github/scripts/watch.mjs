// Official page watcher. Runs on a schedule in GitHub Actions.
// Fetches every official page listed in data/live.json, detects meaningful text changes, and opens
// or updates a GitHub issue per changed page with the dates found on it, for review before data changes.
import fs from "node:fs";
const STATE = ".watch-state/state.json";
const live = JSON.parse(fs.readFileSync("data/live.json", "utf8"));
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const targets = [];
const add = (url, label, ref) => { if (typeof url === "string" && /^https?:\/\//.test(url) && !targets.some(t => t.url === url)) targets.push({ url, label, ref }); };
for (const [id, r] of Object.entries(live.research || {})) { add(r.official_admissions_url, `${r.name}: admissions`, "s:" + id); add(r.international_admissions_url, `${r.name}: international`, "s:" + id); if (r.financial_aid) add(r.financial_aid.source, `${r.name}: financial aid`, "s:" + id); }
for (const [id, p] of Object.entries(live.presearch || {})) { add(p.official_url, `${p.name}`, "p:" + id); }
const MAX = +(process.env.WATCH_MAX || 400);
const norm = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ")
  .replace(/\b(\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?)\b/gi, " ").replace(/copyright[^.]{0,80}/gi, " ").trim();
async function sha(t) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return Buffer.from(b).toString("hex").slice(0, 16); }
const DATE = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2}(,\s*\d{4})?\b|\b\d{4}-\d{2}-\d{2}\b/g;
function dateSnippets(text) { const out = []; let m; DATE.lastIndex = 0; while ((m = DATE.exec(text)) && out.length < 12) { const s = text.slice(Math.max(0, m.index - 90), m.index + m[0].length + 40).trim(); if (/deadline|due|apply|application|decision|notification|priority|submit|open|close/i.test(s)) out.push(s); } return [...new Set(out)]; }
const changed = [], failed = [];
async function check(t) {
  const prev = state[t.url] || {}; const headers = { "User-Agent": "CollegeAdmissionsGuide-PageWatcher/1.0 (+https://admissara.com/)" };
  if (prev.etag) headers["If-None-Match"] = prev.etag; if (prev.lm) headers["If-Modified-Since"] = prev.lm;
  try {
    const r = await fetch(t.url, { headers, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (r.status === 304) { prev.checked = Date.now(); state[t.url] = prev; return; }
    if (!r.ok) { failed.push({ ...t, status: r.status }); return; }
    const text = norm(await r.text()); const h = await sha(text);
    const next = { hash: h, etag: r.headers.get("etag") || "", lm: r.headers.get("last-modified") || "", checked: Date.now(), dates: dateSnippets(text) };
    if (prev.hash && prev.hash !== h) { const before = new Set(prev.dates || []); changed.push({ ...t, newDates: next.dates.filter(d => !before.has(d)), goneDates: (prev.dates || []).filter(d => !next.dates.includes(d)) }); }
    state[t.url] = next;
  } catch (e) { failed.push({ ...t, status: String(e.name || e.message) }); }
}
const queue = targets.slice(0, MAX); let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => { while (i < queue.length) await check(queue[i++]); }));
fs.mkdirSync(".watch-state", { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(state));
console.log(`checked ${queue.length}, changed ${changed.length}, failed ${failed.length}`);
// report through GitHub issues
const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
async function gh(path, opt = {}) { const r = await fetch(`https://api.github.com${path}`, { ...opt, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" } }); if (!r.ok) throw new Error(path + " " + r.status + " " + await r.text()); return r.json(); }
if (repo && token && changed.length) {
  const open = await gh(`/repos/${repo}/issues?labels=page-change&state=open&per_page=100`);
  for (const c of changed) {
    const title = `Official page changed: ${c.label}`.slice(0, 200);
    const body = `**Page:** ${c.url}\n**Record:** \`${c.ref}\`\n**Detected:** ${new Date().toISOString()}\n\n` +
      (c.newDates.length ? `**New date mentions:**\n${c.newDates.map(d => "- " + d).join("\n")}\n\n` : "") +
      (c.goneDates.length ? `**Removed date mentions:**\n${c.goneDates.map(d => "- " + d).join("\n")}\n\n` : "") +
      `Check the page. If a fact in the guide changed (deadline, requirement, cost), update the data and close this issue.`;
    const ex = open.find(x => x.title === title);
    if (ex) await gh(`/repos/${repo}/issues/${ex.number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    else await gh(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body, labels: ["page-change"] }) });
  }
}
