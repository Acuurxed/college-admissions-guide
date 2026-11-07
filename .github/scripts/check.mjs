// Smoke test of the published page plus a link check of official URLs. Opens an issue when something fails.
import fs from "node:fs";
import { chromium } from "playwright";
const problems = [];
const browser = await chromium.launch(); const page = await browser.newPage(); const errs = [];
page.on("pageerror", e => errs.push(e.message));
const url = "file://" + process.cwd() + "/index.html";
await page.goto(url); await page.waitForTimeout(800);
if (!(await page.locator("#f-signin").count())) problems.push("Sign-in screen did not appear.");
await page.evaluate(() => { const em = "ci@example.com"; localStorage.setItem("cag-accounts", JSON.stringify({ [em]: { email: em, role: "student", name: "CI Test", onboarded: true, twofaAsked: true } })); localStorage.setItem("cag-session", JSON.stringify(em)); localStorage.setItem("cag-toured-" + em, "true"); });
for (const h of ["overview", "schools", "school.harvard", "scholarships", "library", "profile", "myschools", "database", "settings", "help"]) {
  await page.goto(url + "#" + h); await page.reload(); await page.waitForTimeout(500);
  const n = await page.locator("#view > *").count(); if (!n) problems.push(`Page #${h} rendered nothing.`);
}
if (errs.length) problems.push("Script errors: " + [...new Set(errs)].slice(0, 5).join(" | "));
await browser.close();
// link check (daily run only)
if (process.env.LINKS === "1") {
  const live = JSON.parse(fs.readFileSync("data/live.json", "utf8")); const urls = new Set();
  for (const r of Object.values(live.research || {})) [r.official_admissions_url, r.international_admissions_url].forEach(u => u && urls.add(u));
  for (const p of Object.values(live.presearch || {})) p.official_url && urls.add(p.official_url);
  const list = [...urls]; const broken = []; let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (i < list.length) { const u = list[i++]; try { const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(20000), headers: { "User-Agent": "CollegeAdmissionsGuide-LinkCheck/1.0" } }); if (r.status === 404 || r.status === 410) broken.push(`${u} (${r.status})`); } catch (e) {} } }));
  if (broken.length) problems.push(`Broken official links (${broken.length}):\n` + broken.map(b => "- " + b).join("\n"));
  const today = new Date().toISOString().slice(0, 10), stale = [];
  for (const p of Object.values(live.presearch || {})) { const d = p.dates && p.dates.application_deadline; if (d && d < today && p.status !== "discontinued") stale.push(`${p.name}: deadline ${d} has passed; look for the next cycle`); }
  if (stale.length) problems.push(`Passed deadlines to refresh (${stale.length}):\n` + stale.slice(0, 60).map(s => "- " + s).join("\n"));
}
console.log(problems.length ? problems.join("\n\n") : "All checks passed");
const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
if (problems.length && repo && token) {
  const title = process.env.LINKS === "1" ? `Daily check report ${new Date().toISOString().slice(0, 10)}` : `Smoke test failed after ${String(process.env.GITHUB_SHA || "").slice(0, 7)}`;
  await fetch(`https://api.github.com/repos/${repo}/issues`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, body: JSON.stringify({ title, body: problems.join("\n\n"), labels: ["automated-check"] }) });
}
if (process.env.LINKS !== "1" && problems.length) process.exit(1);
