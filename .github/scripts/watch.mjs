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
const changed = [], failed = [], proposals = [];
// Proposed corrections: when a changed admissions page states a round deadline that differs from the guide,
// prepare the correction for review. Only a date printed next to the round's name and a deadline word counts,
// every mention on the page must agree, and it must be within 45 days of the date already in the guide.
const schoolsById = Object.fromEntries((live.schools || []).map(s => [s.id, s]));
const ROUND = { ed2: /Early Decision (?:II|2)\b/gi, ed1: /Early Decision (?:I|1)\b(?!I)/gi, ed: /Early Decision\b(?!\s?(?:I|1|2))/gi, rea: /Restrictive Early Action/gi, scea: /Single[- ]Choice Early Action/gi, ea2: /Early Action (?:II|2)\b/gi, ea: /(?<!Restrictive |Choice )Early Action\b(?!\s?(?:II|2))/gi, rd: /Regular Decision/gi };
const RNAME = { ed: "Early Decision", ed1: "Early Decision I", ed2: "Early Decision II", ea: "Early Action", ea2: "Early Action II", rea: "Restrictive Early Action", scea: "Single-Choice Early Action", rd: "Regular Decision" };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ONE = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?/i;
function propose(t, text) {
  if (!/: admissions$/.test(t.label) || !t.ref.startsWith("s:")) return; const sc = schoolsById[t.ref.slice(2)]; if (!sc) return;
  for (const r of sc.R || []) { const re = ROUND[r[0]]; if (!re || !r[1]) continue; const found = new Map(); re.lastIndex = 0; let m;
    while ((m = re.exec(text))) { const ctx = text.slice(Math.max(0, m.index - 80), m.index + 170); if (!/deadline|due|apply by|submit/i.test(ctx)) continue; const d = text.slice(m.index, m.index + 170).match(ONE); if (!d) continue;
      const mo = MONTHS[d[1].slice(0, 3).toLowerCase()], old = new Date(r[1] + "T00:00:00Z"); let y = d[3] ? +d[3] : null, inferred = !d[3];
      if (!y) { y = old.getUTCFullYear(); const c = [y - 1, y, y + 1].map(v => ({ v, gap: Math.abs(Date.UTC(v, mo - 1, +d[2]) - old.getTime()) })).sort((a, b) => a.gap - b.gap)[0]; y = c.v; }
      const iso = `${y}-${String(mo).padStart(2, "0")}-${String(+d[2]).padStart(2, "0")}`; found.set(iso, { snippet: ctx.trim(), inferred }); }
    if (found.size !== 1) continue; const [to, info] = [...found.entries()][0]; if (to === r[1]) continue;
    if (Math.abs(new Date(to + "T00:00:00Z") - new Date(r[1] + "T00:00:00Z")) > 45 * 864e5) continue;
    proposals.push({ id: sc.id, name: sc.name, code: r[0], from: r[1], to, url: t.url, ...info }); }
}
async function check(t) {
  const prev = state[t.url] || {}; const headers = { "User-Agent": "CollegeAdmissionsGuide-PageWatcher/1.0 (+https://admissara.com/)" };
  if (prev.etag) headers["If-None-Match"] = prev.etag; if (prev.lm) headers["If-Modified-Since"] = prev.lm;
  try {
    const r = await fetch(t.url, { headers, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (r.status === 304) { prev.checked = Date.now(); state[t.url] = prev; return; }
    if (!r.ok) { failed.push({ ...t, status: r.status }); return; }
    const text = norm(await r.text()); const h = await sha(text);
    const next = { hash: h, etag: r.headers.get("etag") || "", lm: r.headers.get("last-modified") || "", checked: Date.now(), dates: dateSnippets(text) };
    if (prev.hash && prev.hash !== h) { const before = new Set(prev.dates || []); changed.push({ ...t, newDates: next.dates.filter(d => !before.has(d)), goneDates: (prev.dates || []).filter(d => !next.dates.includes(d)) }); try { propose(t, text); } catch (e) { console.log("propose failed", t.url, e.message); } }
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

// one proposed change (a pull request that edits data/overrides.json) for all corrections found in this run
if (repo && token && proposals.length) {
  let current = {}; try { current = JSON.parse(fs.readFileSync("data/overrides.json", "utf8")); } catch (e) { }
  const fresh = proposals.filter(p => !(current.schools && current.schools[p.id] && current.schools[p.id].R && current.schools[p.id].R[p.code] === p.to));
  const title = `Proposed deadline update: ${fresh.map(p => `${p.name} ${RNAME[p.code]}`).join("; ")}`.slice(0, 240);
  const pulls = await gh(`/repos/${repo}/pulls?state=open&per_page=100`);
  if (fresh.length && !pulls.some(x => x.title === title)) {
    const over = JSON.parse(JSON.stringify(current)); over.schools = over.schools || {};
    for (const p of fresh) { const o = (over.schools[p.id] = over.schools[p.id] || {}); (o.R = o.R || {})[p.code] = p.to; }
    const body = `The page watcher found a deadline on an official page that differs from the guide. **Check each page, then press "Merge pull request" to apply the change.** Close this request to reject it.\n\n` +
      fresh.map(p => `### ${p.name}: ${RNAME[p.code]}\n- In the guide: **${p.from}**\n- On the page: **${p.to}**${p.inferred ? " (the page does not print the year; it was taken from the current cycle)" : ""}\n- Page: ${p.url}\n- Text found: "${p.snippet.replace(/"/g, "'")}"`).join("\n\n");
    const branch = `data-update/${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
    try {
      const main = await gh(`/repos/${repo}/git/ref/heads/main`);
      await gh(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: "refs/heads/" + branch, sha: main.object.sha }) });
      let sha; try { sha = (await gh(`/repos/${repo}/contents/data/overrides.json?ref=${branch}`)).sha; } catch (e) { }
      await gh(`/repos/${repo}/contents/data/overrides.json`, { method: "PUT", body: JSON.stringify({ message: title, content: Buffer.from(JSON.stringify(over, null, 1)).toString("base64"), branch, sha }) });
      try { await gh(`/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title, head: branch, base: "main", body }) }); }
      catch (e) { await gh(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, labels: ["page-change"], body: body + `\n\nTo apply: open https://github.com/${repo}/compare/main...${branch}?expand=1 and create, then merge, the pull request.` }) }); }
      console.log("proposed", fresh.length, "corrections on", branch);
    } catch (e) { console.log("could not prepare the proposal:", e.message); }
  }
}
