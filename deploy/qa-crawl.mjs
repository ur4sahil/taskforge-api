#!/usr/bin/env node
// TaskForge unattended "click every button" QA crawl. Playwright only.
// Runs on the VPS: cd ~/taskforge-qa && nohup node qa-crawl.mjs > crawl.log 2>&1 &
// Credentials are read from /home/ubuntu/taskforge-api/.demo-credentials.txt and never logged.
import { chromium, webkit, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------- device emulation (TF_DEVICE=iphone|pixel; unset = desktop 1440x900 Chromium) ----------
const DEVICE = (process.env.TF_DEVICE || '').toLowerCase();
const DEVICE_MAP = { iphone: { name: 'iPhone 14 Pro', engine: 'webkit' }, pixel: { name: 'Pixel 7', engine: 'chromium' } };
if (DEVICE && !DEVICE_MAP[DEVICE]) { console.error(`unknown TF_DEVICE "${DEVICE}" (use iphone | pixel | unset)`); process.exit(2); }
const DEV = DEVICE ? DEVICE_MAP[DEVICE] : null;
const DESC = DEV ? devices[DEV.name] : null;
if (DEV && !DESC) { console.error(`playwright has no device descriptor "${DEV.name}"`); process.exit(2); }
const MOBILE = !!DEV;
const HAS_TOUCH = MOBILE && !!DESC.hasTouch;
let ENGINE = (process.env.TF_ENGINE || (DEV ? DEV.engine : 'chromium')).toLowerCase(); // may fall back to chromium at launch
let ENGINE_NOTE = '';

const BASE = process.env.TF_WEB || 'https://taskforge.housify365.com';
const SLUG = process.env.TF_SLUG || 'meridian-property-group-demo';
const EMAIL = process.env.TF_EMAIL || 'dana.whitfield@meridian.example';
const CRED_FILE = process.env.TF_CRED_FILE || '/home/ubuntu/taskforge-api/.demo-credentials.txt';
const MAX_PER_PAGE = 60;
const CLICK_SETTLE_MS = 1500;
const GLOBAL_BUDGET_MS = 110 * 60 * 1000; // hard stop; partial report still written

const SKIP_RE = /sign out|log out|export|csv|download|delete forever|permanently|start .*call|video call|voice call|record voice|attach|upload|housify holdings|new workspace|send invitation|resend|revoke|reset password|deactivate|reactivate|remove|leave group|delete/i;
const SEL = 'button, a[href], [role=button], [role=tab], [role=menuitem], input[type=checkbox], select, summary';
const TOAST_SEL = '[role=status], .toast, [class*=toast]';

const PAGES = ['', 'my-tasks', 'my-tasks?scope=all', 'lists', 'calendar', 'search', 'reports', 'templates', 'focus',
  'notifications', 'messages', 'audit', 'trash', 'settings', 'settings?tab=notifications', 'settings?tab=members', 'settings?tab=lists']
  .map(p => ({ key: p === '' ? 'home' : p.replace(/[^a-z0-9]+/gi, '_'), url: `${BASE}/${SLUG}${p ? '/' + p : ''}` }))
  .concat([
    { key: 'auth_forgot_password', url: `${BASE}/auth/forgot-password` },
    { key: 'auth_reset_password_badtoken', url: `${BASE}/auth/reset-password/badtoken` },
  ]);

const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const ROOT = path.join(os.homedir(), 'taskforge-qa');
const OUT = path.join(ROOT, 'out', TS + (DEVICE ? `-${DEVICE}` : ''));
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const LOG_FILE = path.join(OUT, 'crawl.log');
const STATE_FILE = path.join(ROOT, 'storageState.json');
const t0 = Date.now();

function log(...a) {
  const line = `[${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(0)}s] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function readPassword() {
  const txt = fs.readFileSync(CRED_FILE, 'utf8');
  const line = txt.split('\n').find(l => /^shared password/i.test(l) && l.includes(':'));
  if (!line) throw new Error('no password line in credentials file');
  const i = line.indexOf(':', line.search(/password/i));
  const pw = line.slice(i + 1).trim();
  if (!pw) throw new Error('empty password');
  return pw;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = (s, n = 90) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const md = s => short(s, 120).replace(/\|/g, '\\|');

// ---------- report state ----------
function deviceLine() {
  if (!MOBILE) return 'Device: desktop (Chromium, viewport 1440x900, no touch)';
  const vp = DESC.viewport ? `${DESC.viewport.width}x${DESC.viewport.height}` : '?';
  return `Device: ${DEV.name} (TF_DEVICE=${DEVICE}) — engine: ${ENGINE}${ENGINE_NOTE ? ' — ' + ENGINE_NOTE : ''}; viewport ${vp} @${DESC.deviceScaleFactor}x, isMobile=${!!DESC.isMobile}, hasTouch=${!!DESC.hasTouch}; UA: ${DESC.userAgent}`;
}
const report = { startedAt: new Date().toISOString(), base: BASE, slug: SLUG, user: EMAIL, device: null, pages: [], flows: [], skipped: [], suspicious: [] };
function flush() {
  report.updatedAt = new Date().toISOString();
  report.elapsedSec = Math.round((Date.now() - t0) / 1000);
  report.device = { key: DEVICE || 'desktop', name: DEV ? DEV.name : 'desktop', engine: ENGINE, fallback: ENGINE_NOTE || null, viewport: DESC ? DESC.viewport : { width: 1440, height: 900 }, hasTouch: HAS_TOUCH, isMobile: MOBILE && !!DESC.isMobile, line: deviceLine() };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'report.md'), renderMd());
}
function renderMd() {
  const L = [];
  L.push(`# TaskForge QA crawl${MOBILE ? ` [${DEV.name}]` : ''} — ${report.startedAt}`, '', `Base: ${BASE}  Workspace: ${SLUG}  User: ${EMAIL}  Elapsed: ${report.elapsedSec}s`, '', deviceLine(), '');
  if (MOBILE) {
    L.push('## Mobile issues', '');
    const pm = report.pages.filter(p => p.mobile);
    if (!pm.length) L.push('(no pages checked yet)');
    for (const p of pm) {
      const m = p.mobile, iss = [];
      if (m.error) iss.push(`check failed: ${md(m.error)}`);
      if (m.hOverflow) iss.push(`HORIZONTAL OVERFLOW: scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth}; widest: ${m.overflowers.map(md).join('; ')}`);
      if (m.tapTargets && m.tapTargets.small) iss.push(`small tap targets (<36px): ${m.tapTargets.small}/${m.tapTargets.total} — ${m.tapTargets.names.map(md).join('; ')}`);
      if (m.bottomFixed && m.bottomFixed.length) iss.push(`fixed/sticky in bottom 80px: ${m.bottomFixed.map(md).join('; ')}`);
      if (m.clipped && m.clipped.length) iss.push(`clipped text: ${m.clipped.map(md).join('; ')}`);
      if (m.drawer) iss.push(`sidebar drawer: ${m.drawer.present ? `opens=${m.drawer.opened ? 'yes' : 'NO'}, closes on nav tap=${m.drawer.closedOnNav ? 'yes' : 'NO'}` : 'no Toggle sidebar button'} — ${md(m.drawer.detail, 200)}`);
      if (m.dvh) iss.push(`100dvh: body.scrollHeight ${m.dvh.bodyScrollHeight} vs innerHeight ${m.dvh.innerHeight}${m.dvh.composer ? `; composer ${m.dvh.composer.inViewport ? 'visible without scrolling' : 'NOT in viewport'} (top ${m.dvh.composer.top}, bottom ${m.dvh.composer.bottom})` : m.dvh.pageVerticalScroll ? '; page scrolls vertically' : ''}`);
      L.push(`### ${p.key}`, '', ...(iss.length ? iss.map(s => `- ${s}`) : ['- (clean)']), p.shot ? `- screenshot: ${p.shot}` : '', '');
    }
  }
  for (const p of report.pages) {
    L.push(`## ${p.key} — ${p.url}`, '');
    L.push(`Load: ${p.loadMs}ms, final URL: ${p.finalUrl}, title: ${md(p.title)}, console errors on load: ${p.loadErrors.length}, failed requests on load: ${p.loadFailed.length}, elements visible: ${p.elements.length}, clicked: ${p.results.length}`);
    for (const e of p.loadErrors.slice(0, 5)) L.push(`- load console error: ${md(e)}`);
    for (const f of p.loadFailed.slice(0, 8)) L.push(`- load failed request: ${f.status} ${md(f.url)}`);
    L.push('', '| control | result after click | url | dialog | toast | errors |', '|---|---|---|---|---|---|');
    for (const r of p.results) {
      const errs = [...r.consoleErrors.map(e => 'console: ' + e), ...r.failed.map(f => `${f.status} ${f.url}`)].map(md).join('<br>');
      L.push(`| ${md(`${r.tag}${r.role ? '[' + r.role + ']' : ''} "${r.name}"${r.href ? ' → ' + r.href : ''}`)} | ${md(r.result)} | ${md(r.urlAfter === p.url ? '(same)' : r.urlAfter)} | ${r.dialog ? 'yes' + (r.dialogName ? ': ' + md(r.dialogName) : '') : ''} | ${md(r.toast)} | ${errs} |`);
    }
    L.push('');
  }
  L.push('## Flows', '');
  for (const f of report.flows) L.push(`- **${f.name}**: ${f.ok ? 'OK' : 'FAIL'} — ${md(f.detail, 300)}${f.shot ? ` (shot: ${f.shot})` : ''}`);
  L.push('', '## Suspicious', '');
  if (!report.suspicious.length) L.push('(none)');
  for (const s of report.suspicious) L.push(`- [${s.page}] ${md(s.control)} — ${md(s.reason, 300)}${s.shot ? ` (shot: ${s.shot})` : ''}`);
  L.push('', '## Skipped (destructive/external)', '');
  for (const s of report.skipped) L.push(`- [${s.page}] ${md(`${s.tag} "${s.name}"${s.href ? ' → ' + s.href : ''}`)}`);
  return L.join('\n') + '\n';
}

// ---------- browser plumbing ----------
let browser, context, page;
const consoleErrors = [], failed = [];
async function newPage() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  page = await context.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(short(m.text(), 300)); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + short(e.message, 300)));
  page.on('response', r => { if (r.status() >= 400) failed.push({ status: r.status(), url: short(r.url(), 200) }); });
  page.on('requestfailed', r => { const f = r.failure(); if (f && !/net::ERR_ABORTED/.test(f.errorText)) failed.push({ status: 'netfail ' + f.errorText, url: short(r.url(), 200) }); });
  return page;
}
async function settle(ms = 15000) {
  await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), sleep(ms)]);
}
async function goto(url, idleMs = 15000) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await settle(idleMs);
  if (page.url().includes('/auth/login') && !url.includes('/auth/')) {
    log('session lost, re-logging in');
    await login();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(idleMs);
  }
}
async function login() {
  const pw = readPassword();
  // Fill only after hydration: values typed before React mounts never reach its state.
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(1500);
  await page.locator('input[type=email]').fill(EMAIL);
  await page.locator('input[type=password]').fill(pw);
  // Headless click on the submit button does not submit; Enter does.
  await page.locator('input[type=password]').press('Enter');
  await page.waitForURL(u => u.pathname.startsWith(`/${SLUG}`), { timeout: 45000, waitUntil: 'commit' });
  await settle(10000);
  await context.storageState({ path: STATE_FILE });
  log(`LOGIN OK as ${EMAIL} -> ${page.url()} (storageState saved)`);
}
async function snapshot() {
  return page.evaluate(() => {
    const txt = document.body ? document.body.innerText : '';
    let h = 0; for (let i = 0; i < txt.length; i++) h = (h * 31 + txt.charCodeAt(i)) | 0;
    const dlg = [...document.querySelectorAll('[role=dialog], [aria-modal=true]')].filter(d => d.getClientRects().length);
    const toasts = [...document.querySelectorAll('[role=status], .toast, [class*=toast]')].filter(d => d.getClientRects().length).map(d => (d.innerText || '').trim()).filter(Boolean);
    return { url: location.href, len: txt.length, hash: h, dialogs: dlg.length, dialogName: dlg[0] ? (dlg[0].getAttribute('aria-label') || (dlg[0].querySelector('h1,h2,h3') || {}).innerText || '') : '', toasts: toasts.join(' / ').slice(0, 200), title: document.title };
  }).catch(() => ({ url: page.url(), len: 0, hash: 0, dialogs: 0, dialogName: '', toasts: '', title: '' }));
}
function isErrorPage(snap) {
  return /404|could not be found|application error|something went wrong|unhandled runtime error/i.test(snap.title) || (snap.len < 400 && /404|could not be found|application error/i.test(snap.title + ' '));
}
async function enumerate() {
  return page.evaluate((sel) => {
    const all = [...document.querySelectorAll(sel)];
    const out = [];
    all.forEach((el, idx) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && el.getClientRects().length > 0;
      if (!visible) return;
      if (el.disabled) return;
      const tag = el.tagName.toLowerCase();
      const roleAttr = el.getAttribute('role');
      const name = (el.getAttribute('aria-label') || (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ') || el.getAttribute('title') || (el.querySelector('img') || {}).alt || el.getAttribute('name') || '').slice(0, 80);
      const type = el.getAttribute('type') || '';
      const href = tag === 'a' ? el.getAttribute('href') : '';
      let role = roleAttr || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : (tag === 'input' && type === 'checkbox') ? 'checkbox' : '');
      out.push({ idx, tag, role, name, type, href: href || '', selectValue: tag === 'select' ? el.value : undefined, inMain: !!el.closest('main') });
    });
    return out;
  }, SEL);
}
async function locate(el) {
  if (el.role && el.name && el.tag !== 'summary') {
    const loc = page.getByRole(el.role, { name: el.name, exact: true });
    const n = await loc.count().catch(() => 0);
    if (n >= 1) return loc.first();
  }
  const nth = page.locator(SEL).nth(el.idx);
  if (await nth.count() === 1) {
    const txt = await nth.evaluate(e => (e.getAttribute('aria-label') || (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' ') || e.getAttribute('title') || '').slice(0, 80)).catch(() => null);
    if (txt === el.name) return nth;
  }
  if (el.name) {
    const byText = page.locator(SEL).filter({ hasText: el.name }).first();
    if (await byText.count()) return byText;
  }
  return nth;
}
async function shot(name, full = false) {
  const file = `${name}.png`;
  // Mobile runs shoot at device size only (full page off) so the capture equals what the phone shows.
  try { await page.screenshot({ path: path.join(SHOTS, file), fullPage: MOBILE ? false : full, timeout: 15000 }); return `shots/${file}`; } catch (e) { log('screenshot failed', name, e.message); return ''; }
}
// Touch devices tap; everything else clicks. Same options object (timeout, force) for both.
async function tap(loc, opts = {}) {
  if (HAS_TOUCH) return loc.tap(opts);
  return loc.click(opts);
}

// ---------- mobile checks (TF_DEVICE only) ----------
async function mobileChecks() {
  return page.evaluate(() => {
    const iw = window.innerWidth, ih = window.innerHeight;
    const vis = el => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && el.getClientRects().length > 0; };
    const nm = el => (el.getAttribute('aria-label') || (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ') || el.getAttribute('title') || el.getAttribute('placeholder') || el.id || '').slice(0, 50);
    const desc = el => `<${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className.trim() ? ' class="' + el.className.trim().split(/\s+/).slice(0, 5).join(' ') + '"' : ''}>`;
    const label = el => { const n = nm(el); return n ? `${desc(el)} "${n}"` : desc(el); };
    const out = { innerWidth: iw, innerHeight: ih };
    const all = [...document.querySelectorAll('body *')].filter(vis);
    // (a) horizontal overflow + the widest offenders
    out.scrollWidth = document.documentElement.scrollWidth;
    out.hOverflow = out.scrollWidth > iw + 1;
    out.overflowers = [];
    if (out.hOverflow) {
      out.overflowers = all.map(el => ({ el, r: el.getBoundingClientRect() })).filter(x => x.r.right > iw + 1 && x.r.width > 0)
        .sort((a, b) => b.r.right - a.r.right).slice(0, 5).map(x => `${label(x.el)} right=${Math.round(x.r.right)} width=${Math.round(x.r.width)}`);
    }
    // (b) tap targets smaller than 36px in either dimension
    const targets = all.filter(el => el.matches('button, a[href], [role=button], [role=tab], [role=menuitem], input[type=checkbox]'));
    const small = targets.map(el => ({ el, r: el.getBoundingClientRect() })).filter(x => x.r.width < 36 || x.r.height < 36);
    out.tapTargets = { total: targets.length, small: small.length, names: small.slice(0, 8).map(x => `${label(x.el)} ${Math.round(x.r.width)}x${Math.round(x.r.height)}`) };
    // (c) fixed/sticky elements overlapping the bottom 80px (keyboard / composer zone)
    out.bottomFixed = all.filter(el => { const p = getComputedStyle(el).position; return p === 'fixed' || p === 'sticky'; })
      .map(el => ({ el, r: el.getBoundingClientRect() })).filter(x => x.r.bottom > ih - 80 && x.r.top < ih)
      .slice(0, 8).map(x => `${label(x.el)} y=${Math.round(x.r.top)}-${Math.round(x.r.bottom)} (${getComputedStyle(x.el).position})`);
    // (d) clipped text among headings/buttons
    out.clipped = all.filter(el => el.matches('h1, h2, h3, h4, button, [role=button], [role=tab]'))
      .filter(el => { const cs = getComputedStyle(el); return /hidden|clip/.test(cs.overflowX + ' ' + cs.overflow) && el.scrollWidth > el.clientWidth + 1; })
      .slice(0, 5).map(el => `${label(el)} scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
    // (f) 100dvh sanity: does the page scroll vertically, and is the message composer inside the viewport?
    const comp = [...document.querySelectorAll('textarea, input[placeholder*="essage"], [contenteditable=true]')].filter(vis).find(el => /message/i.test(el.getAttribute('placeholder') || el.getAttribute('aria-label') || '')) || null;
    const cr = comp ? comp.getBoundingClientRect() : null;
    out.dvh = { bodyScrollHeight: document.body.scrollHeight, docScrollHeight: document.documentElement.scrollHeight, innerHeight: ih, pageVerticalScroll: document.documentElement.scrollHeight > ih + 1,
      composer: comp ? { top: Math.round(cr.top), bottom: Math.round(cr.bottom), inViewport: cr.top >= 0 && cr.bottom <= ih + 1, name: nm(comp) } : null };
    return out;
  });
}
// (e) does the mobile sidebar drawer open from "Toggle sidebar" and close again when a nav link is tapped?
async function drawerCheck() {
  const navLinks = page.locator('nav a[href], aside a[href], [role=navigation] a[href]');
  const firstVisible = async () => { const n = await navLinks.count(); for (let i = 0; i < Math.min(n, 25); i++) { const l = navLinks.nth(i); if (await l.isVisible().catch(() => false)) return l; } return null; };
  const btn = page.getByRole('button', { name: 'Toggle sidebar' }).first();
  if (!(await btn.count()) || !(await btn.isVisible().catch(() => false))) return { present: false, opened: false, closedOnNav: false, detail: 'no visible "Toggle sidebar" button' };
  const visibleBefore = !!(await firstVisible());
  await tap(btn, { timeout: 5000 });
  await sleep(900);
  const link = await firstVisible();
  const opened = !!link;
  if (!link) { await page.keyboard.press('Escape').catch(() => {}); return { present: true, opened: false, closedOnNav: false, detail: `nav links visible before toggle=${visibleBefore}; after tapping Toggle sidebar no nav link became visible` }; }
  const linkName = short(await link.innerText().catch(() => ''), 40);
  const linkHref = await link.getAttribute('href').catch(() => '');
  const urlBefore = page.url();
  await tap(link, { timeout: 5000 });
  await sleep(1800);
  const stillVisible = !!(await firstVisible());
  const closedOnNav = !stillVisible;
  return { present: true, opened, closedOnNav, detail: `nav links visible before toggle=${visibleBefore}; after toggle visible=${opened}; tapped "${linkName}" (${linkHref}) → ${page.url() === urlBefore ? 'url unchanged' : page.url()}; drawer links still visible after nav=${stillVisible}` };
}

// ---------- page crawl ----------
const seenLinks = new Map(); // href -> first page key (global link dedupe: sidebar links repeat on every page)
async function crawlPage(P) {
  log(`PAGE ${P.key} start ${P.url}`);
  await newPage();
  const ce0 = consoleErrors.length, f0 = failed.length;
  const tl = Date.now();
  await goto(P.url);
  const rec = { key: P.key, url: P.url, loadMs: Date.now() - tl, finalUrl: page.url(), title: await page.title().catch(() => ''), loadErrors: consoleErrors.slice(ce0), loadFailed: failed.slice(f0), elements: [], results: [] };
  rec.shot = await shot(P.key, true);
  if (MOBILE) {
    try { rec.mobile = await mobileChecks(); } catch (err) { rec.mobile = { error: short(err.message, 200) }; }
    const m = rec.mobile;
    log(`  ${P.key}: MOBILE overflow=${m.hOverflow ? `YES(${m.scrollWidth}>${m.innerWidth}: ${m.overflowers[0] || ''})` : 'no'} smallTaps=${m.tapTargets ? m.tapTargets.small + '/' + m.tapTargets.total : '?'} bottomFixed=${m.bottomFixed ? m.bottomFixed.length : '?'} clipped=${m.clipped ? m.clipped.length : '?'} dvh=${m.dvh ? m.dvh.bodyScrollHeight + '/' + m.dvh.innerHeight : '?'}${m.error ? ' ERR ' + m.error : ''}`);
  }
  let els = await enumerate();
  rec.elementsTotalVisible = els.length;
  // dedupe by tag+name(+href)
  const seen = new Set(); const uniq = [];
  for (const e of els) { const k = `${e.tag}|${e.role}|${e.name}|${e.href}`; if (seen.has(k)) continue; seen.add(k); uniq.push(e); }
  rec.elements = uniq.map(e => ({ tag: e.tag, role: e.role, name: e.name, href: e.href, type: e.type }));
  const todo = [];
  for (const e of uniq) {
    if (SKIP_RE.test(e.name) || SKIP_RE.test(e.href)) { report.skipped.push({ page: P.key, tag: e.tag, name: e.name, href: e.href }); continue; }
    if (/^(mailto|tel):/.test(e.href)) { report.skipped.push({ page: P.key, tag: e.tag, name: e.name, href: e.href + ' (external scheme)' }); continue; }
    if (e.tag === 'a' && e.href) {
      const abs = new URL(e.href, P.url).href;
      if (seenLinks.has(abs)) { rec.results.push({ ...e, result: `link already clicked on page "${seenLinks.get(abs)}"`, urlAfter: P.url, dialog: false, toast: '', consoleErrors: [], failed: [], dedupe: true }); continue; }
      seenLinks.set(abs, P.key);
    }
    todo.push(e);
  }
  const list = todo.slice(0, MAX_PER_PAGE);
  if (todo.length > MAX_PER_PAGE) log(`  ${P.key}: ${todo.length} clickable, capping at ${MAX_PER_PAGE}`);
  log(`  ${P.key}: loaded in ${rec.loadMs}ms, ${els.length} visible, ${uniq.length} unique, ${list.length} to click, ${report.skipped.filter(s => s.page === P.key).length} skipped`);
  report.pages.push(rec); flush();
  if (MOBILE && !P.url.includes('/auth/')) {
    try { rec.mobile.drawer = await drawerCheck(); } catch (err) { rec.mobile.drawer = { present: true, opened: false, closedOnNav: false, detail: 'drawer check failed: ' + short(err.message, 200) }; }
    log(`  ${P.key}: MOBILE drawer present=${rec.mobile.drawer.present} opened=${rec.mobile.drawer.opened} closedOnNav=${rec.mobile.drawer.closedOnNav} — ${short(rec.mobile.drawer.detail, 160)}`);
    if (rec.mobile.drawer.present && (!rec.mobile.drawer.opened || !rec.mobile.drawer.closedOnNav)) report.suspicious.push({ page: P.key, control: 'button "Toggle sidebar" (mobile drawer)', reason: rec.mobile.drawer.detail, shot: await shot(`${P.key}__drawer`) });
    flush();
  }

  for (let n = 0; n < list.length; n++) {
    if (Date.now() - t0 > GLOBAL_BUDGET_MS) { log('GLOBAL BUDGET EXCEEDED, stopping page loop'); break; }
    const e = list[n];
    const r = { tag: e.tag, role: e.role, name: e.name, href: e.href, type: e.type, result: '', urlAfter: '', dialog: false, dialogName: '', toast: '', consoleErrors: [], failed: [], shot: '' };
    rec.results.push(r);
    try {
      if (n > 0 || page.url() !== P.url) { await goto(P.url, 6000); }
      await page.keyboard.press('Escape').catch(() => {});
      const before = await snapshot();
      const loc = await locate(e);
      if (!(await loc.count())) { r.result = 'NOT FOUND on reload'; r.urlAfter = page.url(); continue; }
      const ce0 = consoleErrors.length, f0 = failed.length;
      if (e.tag === 'select') {
        const opts = await loc.locator('option').count();
        if (opts >= 2) {
          const orig = await loc.inputValue().catch(() => null);
          await loc.selectOption({ index: 1 }, { timeout: 5000 });
          await sleep(CLICK_SETTLE_MS);
          const mid = await snapshot();
          if (orig !== null) await loc.selectOption(orig, { timeout: 5000 }).catch(() => {});
          await sleep(500);
          r.result = `selected 2nd option (${mid.hash !== before.hash ? 'content changed' : 'no visible change'}), restored`;
        } else r.result = `select has ${opts} option(s), not changed`;
      } else if (e.tag === 'input' && e.type === 'checkbox') {
        await tap(loc, { timeout: 5000, force: true });
        await sleep(700);
        const mid = await snapshot();
        await tap(loc, { timeout: 5000, force: true }).catch(() => {});
        await sleep(CLICK_SETTLE_MS - 700);
        r.result = `toggled twice (${mid.hash !== before.hash ? 'content changed after 1st' : 'no visible change after 1st'})`;
      } else {
        try { await tap(loc, { timeout: 5000 }); }
        catch (err) { await tap(loc, { timeout: 3000, force: true }); r.result = 'forced click; '; }
        await sleep(CLICK_SETTLE_MS);
      }
      const after = await snapshot();
      r.urlAfter = after.url; r.dialog = after.dialogs > before.dialogs; r.dialogName = r.dialog ? after.dialogName : ''; r.toast = after.toasts;
      r.consoleErrors = consoleErrors.slice(ce0); r.failed = failed.slice(f0);
      const navigated = after.url !== before.url;
      const changed = after.hash !== before.hash;
      const parts = [];
      if (navigated) parts.push('navigated');
      if (r.dialog) parts.push('dialog opened');
      if (after.toasts) parts.push('toast');
      if (!navigated && !r.dialog && changed) parts.push('content changed');
      if (!navigated && !r.dialog && !changed && !after.toasts) parts.push('no visible change');
      r.result += parts.join(', ') || 'clicked';
      const errorPage = isErrorPage(after);
      if (errorPage) r.result += ' — ERROR/404 PAGE';
      const notable = navigated || r.dialog || r.consoleErrors.length || r.failed.length || errorPage;
      if (notable) r.shot = await shot(`${P.key}__${n}`);
      const dead = (e.tag === 'button' || e.role === 'button') && !navigated && !r.dialog && !changed && !after.toasts;
      const reasons = [];
      if (r.consoleErrors.length) reasons.push(`${r.consoleErrors.length} console error(s): ${r.consoleErrors[0]}`);
      if (r.failed.length) reasons.push(`${r.failed.length} failed request(s): ${r.failed[0].status} ${r.failed[0].url}`);
      if (dead) reasons.push('possible dead button (no navigation, dialog, toast or content change)');
      if (errorPage) reasons.push(`landed on error page: ${after.title} ${after.url}`);
      if (reasons.length) report.suspicious.push({ page: P.key, control: `${e.tag} "${e.name}"${e.href ? ' → ' + e.href : ''}`, reason: reasons.join('; '), shot: r.shot, urlAfter: after.url });
      await page.keyboard.press('Escape').catch(() => {});
      log(`  [${P.key} ${n + 1}/${list.length}] ${e.tag} "${short(e.name, 40)}" -> ${r.result}${navigated ? ' ' + after.url : ''}${reasons.length ? ' !! ' + reasons.join('; ') : ''}`);
    } catch (err) {
      r.result = 'CLICK FAILED: ' + short(err.message, 200); r.urlAfter = page.url();
      r.shot = await shot(`${P.key}__${n}`);
      report.suspicious.push({ page: P.key, control: `${e.tag} "${e.name}"`, reason: r.result, shot: r.shot });
      log(`  [${P.key} ${n + 1}/${list.length}] ${e.tag} "${short(e.name, 40)}" -> ${r.result}`);
      if (page.isClosed()) await newPage();
    }
    if (n % 5 === 4) flush();
  }
  flush();
  log(`PAGE ${P.key} done (${rec.results.length} results)`);
}

// ---------- explicit flows ----------
const W = `${BASE}/${SLUG}`;
const stamp = Date.now();
const TASK_TITLE = `QA crawl task ${stamp}`;
async function flow(name, fn) {
  const f = { name, ok: false, detail: '', shot: '' };
  const ce0 = consoleErrors.length, f0 = failed.length;
  log(`FLOW ${name} start`);
  try {
    await newPage();
    f.detail = (await fn()) || 'done';
    f.ok = true;
  } catch (err) {
    f.detail = 'FAIL: ' + short(err.message, 300);
    f.shot = await shot(`flow__${name.replace(/[^a-z0-9]+/gi, '_')}__fail`);
  }
  f.consoleErrors = consoleErrors.slice(ce0); f.failed = failed.slice(f0);
  if (f.consoleErrors.length || f.failed.length) f.detail += ` | ${f.consoleErrors.length} console errors, ${f.failed.length} failed requests (${f.failed.map(x => x.status + ' ' + x.url).slice(0, 2).join('; ')})`;
  if (!f.ok || f.consoleErrors.length || f.failed.length) report.suspicious.push({ page: 'flow:' + name, control: name, reason: f.detail, shot: f.shot });
  report.flows.push(f); flush();
  log(`FLOW ${name} ${f.ok ? 'OK' : 'FAIL'}: ${short(f.detail, 200)}`);
}
async function mainClickable() {
  const m = page.locator('main');
  for (const sel of ['a[href]', '[role=button]', 'button', 'li', '[role=listitem]']) {
    const items = m.locator(sel);
    const n = await items.count();
    for (let i = 0; i < Math.min(n, 15); i++) {
      const it = items.nth(i);
      if (!(await it.isVisible().catch(() => false))) continue;
      const txt = short(await it.innerText().catch(() => ''), 80);
      if (txt.length < 3 || SKIP_RE.test(txt)) continue;
      return { loc: it, txt, sel };
    }
  }
  return null;
}
async function openFirstConversation() {
  await goto(`${W}/messages`);
  const m = page.locator('main');
  const conv = m.locator('button, [role=button], a[href]').filter({ hasNotText: /^$/ });
  const n = await conv.count();
  let picked = null;
  for (let i = 0; i < Math.min(n, 30); i++) {
    const it = conv.nth(i);
    if (!(await it.isVisible().catch(() => false))) continue;
    const txt = short(await it.innerText().catch(() => ''), 80);
    if (txt.length < 4 || SKIP_RE.test(txt) || /^(new|search|filter|toggle sidebar)/i.test(txt)) continue;
    picked = { it, txt }; break;
  }
  if (!picked) throw new Error('no conversation element found');
  await tap(picked.it, { timeout: 10000 });
  await sleep(2000);
  return picked;
}
// Box geometry helpers for the mobile flows.
const vp = () => page.viewportSize() || DESC.viewport;
const fits = b => !!b && b.x >= -1 && b.y >= -1 && b.x + b.width <= vp().width + 1 && b.y + b.height <= vp().height + 1;
const boxStr = b => b ? `x=${Math.round(b.x)} y=${Math.round(b.y)} w=${Math.round(b.width)} h=${Math.round(b.height)}` : 'no box';

async function runMobileFlows() {
  await flow('mobile: My Tasks task panel fits viewport', async () => {
    await goto(`${W}/my-tasks`);
    let t = page.getByText(TASK_TITLE, { exact: true }).first();
    if (!(await t.count()) || !(await t.isVisible().catch(() => false))) { const alt = await mainClickable(); if (!alt) throw new Error('no task row to open'); t = alt.loc; }
    await tap(t, { timeout: 10000 });
    const dlg = page.getByRole('dialog', { name: /^Task: / });
    await dlg.waitFor({ state: 'visible', timeout: 10000 });
    const b = await dlg.boundingBox();
    const close = dlg.getByRole('button', { name: 'Close', exact: true }).first();
    const closeVisible = await close.isVisible().catch(() => false);
    const cb = closeVisible ? await close.boundingBox() : null;
    const inner = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, sw: document.documentElement.scrollWidth }));
    await shot('mobile__task_panel');
    const detail = `panel ${boxStr(b)} viewport ${inner.w}x${inner.h} docScrollWidth=${inner.sw}; close button ${closeVisible ? (fits(cb) ? 'visible inside viewport' : 'visible but OUTSIDE viewport') : 'NOT visible'} ${boxStr(cb)}`;
    if (!b || b.width > inner.w + 1) throw new Error('panel wider than viewport: ' + detail);
    if (!closeVisible || !fits(cb)) throw new Error('close button not usable: ' + detail);
    if (closeVisible) { await tap(close, { timeout: 5000 }); await sleep(800); }
    return detail + `; after Close dialogs=${(await snapshot()).dialogs}`;
  });
  await flow('mobile: Calendar day with tasks → day sheet', async () => {
    await goto(`${W}/calendar`);
    // The mobile-only day buttons are labelled "<n> task(s) on <Month d>" (calendar/page.tsx, sm:hidden).
    const days = page.locator('main button[aria-label*=" on "]').filter({ hasText: /^$/ });
    let n = await days.count();
    let tries = 0;
    while (!n && tries < 2) { await tap(page.getByRole('button', { name: 'Next month' }), { timeout: 8000 }); await sleep(1200); n = await days.count(); tries++; }
    if (!n) throw new Error('no day button with tasks found in this or the next 2 months');
    const day = days.first();
    const label = await day.getAttribute('aria-label');
    await tap(day, { timeout: 8000, force: true });
    const sheet = page.getByRole('dialog', { name: /^Tasks due / });
    await sheet.waitFor({ state: 'visible', timeout: 8000 });
    const sb = await sheet.boundingBox();
    const items = await sheet.locator('a, button, li').count();
    await shot('mobile__calendar_day_sheet');
    await page.keyboard.press('Escape').catch(() => {});
    return `tapped "${label}" → sheet "${await sheet.getAttribute('aria-label').catch(() => '')}" ${boxStr(sb)} fits=${fits(sb)} items=${items} (months advanced: ${tries})`;
  });
  await flow('mobile: Messages ⋯ menu within viewport + composer visible', async () => {
    const picked = await openFirstConversation();
    const geo = await page.evaluate(() => {
      const c = [...document.querySelectorAll('textarea, input[placeholder*="essage"]')].find(e => e.getClientRects().length);
      const r = c ? c.getBoundingClientRect() : null;
      return { bodyScrollHeight: document.body.scrollHeight, docScrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight, innerWidth: window.innerWidth, composer: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), inViewport: r.top >= 0 && r.bottom <= window.innerHeight + 1 } : null };
    });
    // Messages render after the first page fetch; give them up to 10 s before judging the toolbar.
    await page.locator('[data-message-id]').first().waitFor({ timeout: 10000 }).catch(() => {});
    const more = page.getByRole('button', { name: 'Message actions' });
    const cnt = await more.count();
    if (!cnt) throw new Error(`conversation "${picked.txt}" opened but no "Message actions" (⋯) button found; composer=${JSON.stringify(geo.composer)}`);
    // Pick the last visible ⋯ (newest message, nearest the composer) so the menu has to open near the bottom edge.
    let target = null;
    for (let i = cnt - 1; i >= 0; i--) { const b = more.nth(i); if (await b.isVisible().catch(() => false)) { target = b; break; } }
    if (!target) { target = more.last(); await target.scrollIntoViewIfNeeded().catch(() => {}); }
    const tb = await target.boundingBox();
    try { await tap(target, { timeout: 5000 }); } catch { await tap(target, { timeout: 3000, force: true }); }
    const menu = page.getByRole('menu', { name: 'Message actions' });
    await menu.waitFor({ state: 'visible', timeout: 6000 });
    const mb = await menu.boundingBox();
    const items = await menu.getByRole('menuitem').allInnerTexts().catch(() => []);
    await shot('mobile__message_menu');
    await page.keyboard.press('Escape').catch(() => {});
    const detail = `conversation "${picked.txt}"; ⋯ buttons=${cnt} tapped ${boxStr(tb)} (${tb && tb.width < 36 ? 'SMALL tap target' : 'ok size'}); menu ${boxStr(mb)} within viewport=${fits(mb)} items=[${items.map(s => short(s, 20)).join(', ')}]; dvh: body.scrollHeight ${geo.bodyScrollHeight}/doc ${geo.docScrollHeight} vs innerHeight ${geo.innerHeight}; composer ${geo.composer ? (geo.composer.inViewport ? 'visible without scrolling' : 'NOT in viewport') + ` (top ${geo.composer.top}, bottom ${geo.composer.bottom})` : 'NOT FOUND'}`;
    if (!fits(mb)) throw new Error('menu outside viewport: ' + detail);
    if (!geo.composer || !geo.composer.inViewport) throw new Error('composer not visible: ' + detail);
    return detail;
  });
  await flow('mobile: Settings tabs reachable (horizontal scroll, no clipping)', async () => {
    await goto(`${W}/settings`);
    const list = page.getByRole('tablist', { name: 'Settings sections' }).first();
    await list.waitFor({ state: 'visible', timeout: 10000 });
    const tabs = list.getByRole('tab');
    const n = await tabs.count();
    if (!n) throw new Error('tablist has no tabs');
    const lg = await list.evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX, right: Math.round(el.getBoundingClientRect().right) }));
    const names = [], clippedBefore = [], unreachable = [];
    for (let i = 0; i < n; i++) {
      const t = tabs.nth(i);
      const nm = short(await t.innerText().catch(() => ''), 30);
      const before = await t.boundingBox();
      const clipped = !before || before.x < 0 || before.x + before.width > vp().width + 1;
      if (clipped) clippedBefore.push(`${nm} (${boxStr(before)})`);
      await t.scrollIntoViewIfNeeded().catch(() => {});
      const after = await t.boundingBox();
      try { await tap(t, { timeout: 6000 }); } catch { unreachable.push(`${nm}: tap failed`); continue; }
      await sleep(1200);
      const selected = await t.getAttribute('aria-selected').catch(() => null);
      if (selected !== 'true' && !new URL(page.url()).search.includes('tab=')) unreachable.push(`${nm}: not selected after tap`);
      names.push(`${nm}→${new URL(page.url()).search || '(no ?tab)'} sel=${selected} ${fits(after) ? 'in-view' : 'OUT-OF-VIEW'}`);
      await shot(`mobile__settings_tab_${i}`);
    }
    const detail = `${n} tabs; tablist scrollWidth ${lg.scrollWidth} clientWidth ${lg.clientWidth} overflow-x=${lg.overflowX} (${lg.scrollWidth > lg.clientWidth + 1 ? 'scrolls horizontally' : 'all fit'}); clipped before scroll: [${clippedBefore.join('; ') || 'none'}]; ${names.join('; ')}`;
    if (unreachable.length) throw new Error(`unreachable tabs: ${unreachable.join('; ')} — ${detail}`);
    return detail;
  });
}

async function runFlows() {
  await flow('create task from My Tasks', async () => {
    await goto(`${W}/my-tasks`);
    await tap(page.getByRole('button', { name: /^(New task|Task)$/ }).first(), { timeout: 10000 });
    await page.getByLabel('Task name').fill(TASK_TITLE, { timeout: 10000 });
    await tap(page.getByRole('button', { name: 'Create Task' }), { timeout: 10000 });
    await page.getByText(TASK_TITLE, { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
    await shot('flow__create_task');
    return `created and visible: "${TASK_TITLE}"`;
  });
  await flow('open created task side panel', async () => {
    await goto(`${W}/my-tasks`);
    const t = page.getByText(TASK_TITLE, { exact: true }).first();
    await t.waitFor({ state: 'visible', timeout: 15000 });
    await tap(t, { timeout: 10000 });
    const dlg = page.getByRole('dialog', { name: /Task: QA crawl task/ });
    await dlg.waitFor({ state: 'visible', timeout: 10000 });
    const heading = await dlg.locator('h1, h2, h3, [class*=title], input[aria-label*=itle]').first().evaluate(e => e.value || e.innerText).catch(() => '');
    await shot('flow__open_task');
    return `panel aria-label matched; heading/title field: "${short(heading, 80)}"`;
  });
  await flow('My Tasks → All + Load more', async () => {
    await goto(`${W}/my-tasks`);
    await tap(page.getByRole('button', { name: 'All', exact: true }).first(), { timeout: 10000 });
    await sleep(2000);
    const lm = page.getByRole('button', { name: /^Load more/ });
    let detail = `url=${page.url()}`;
    if (await lm.count() && await lm.first().isVisible()) { await tap(lm.first(), { timeout: 5000 }); await sleep(2500); detail += '; Load more clicked'; } else detail += '; no Load more button';
    await shot('flow__my_tasks_all');
    return detail;
  });
  await flow('open first list card', async () => {
    await goto(`${W}/lists`);
    const card = page.locator(`main a[href*="/${SLUG}/lists/"]`).first();
    await card.waitFor({ state: 'visible', timeout: 15000 });
    const label = short(await card.innerText(), 60);
    await tap(card, { timeout: 10000 });
    await page.waitForURL(/\/lists\/[^/?]+/, { timeout: 15000, waitUntil: 'commit' });
    await settle(8000);
    const crumb = short(await page.locator('nav[aria-label=Breadcrumb]').first().innerText().catch(() => ''), 100);
    const h1 = short(await page.locator('main h1, h1').first().innerText().catch(() => ''), 80);
    await shot('flow__first_list');
    if (!h1) throw new Error('no h1 on list page');
    return `card "${label}" → ${page.url()} breadcrumb="${crumb}" h1="${h1}"`;
  });
  await flow('Calendar next/prev/Today', async () => {
    await goto(`${W}/calendar`);
    const hdr = async () => short(await page.locator('main h1, main h2').first().innerText().catch(() => ''), 40);
    const a = await hdr();
    await tap(page.getByRole('button', { name: 'Next month' }), { timeout: 10000 }); await sleep(1200);
    const b = await hdr();
    await tap(page.getByRole('button', { name: 'Previous month' }), { timeout: 10000 }); await sleep(1200);
    await tap(page.getByRole('button', { name: 'Previous month' }), { timeout: 10000 }); await sleep(1200);
    const c = await hdr();
    await tap(page.getByRole('button', { name: 'Today', exact: true }), { timeout: 10000 }); await sleep(1200);
    const d = await hdr();
    await shot('flow__calendar');
    if (a === b && b === c) throw new Error(`month header did not change: "${a}"`);
    return `start="${a}" next="${b}" prev×2="${c}" today="${d}"`;
  });
  await flow('search "lease" + first result', async () => {
    await goto(`${W}/search`);
    const inp = page.getByPlaceholder('Search tasks and comments...');
    await inp.fill('lease', { timeout: 10000 });
    await inp.press('Enter');
    await sleep(3000);
    await shot('flow__search_results');
    const first = await mainClickable();
    if (!first) throw new Error('no clickable search result found');
    await tap(first.loc, { timeout: 10000 });
    await sleep(2000);
    await shot('flow__search_click');
    return `clicked "${first.txt}" (${first.sel}) → ${page.url()} dialogs=${(await snapshot()).dialogs}`;
  });
  await flow('Templates → Apply first template', async () => {
    await goto(`${W}/templates`);
    const apply = page.getByRole('button', { name: 'Apply', exact: true }).first();
    await apply.waitFor({ state: 'visible', timeout: 15000 });
    await tap(apply, { timeout: 10000 });
    await sleep(1000);
    const sel = page.getByLabel('Target list');
    let detail = '';
    if (await sel.count()) { await sel.selectOption({ index: 1 }, { timeout: 5000 }); detail = 'picked first list; '; }
    else {
      const nl = page.locator('[role=dialog] input').first();
      if (await nl.count()) { await nl.fill(`QA crawl list ${stamp}`); detail = 'list template: typed new list name; '; }
    }
    const confirm = page.locator('[role=dialog]').getByRole('button', { name: /^Apply/ }).last();
    await tap(confirm, { timeout: 10000 });
    await sleep(3000);
    const s = await snapshot();
    await shot('flow__templates_apply');
    return detail + `after Apply: url=${s.url} toast="${s.toasts}" dialogs=${s.dialogs}`;
  });
  await flow('Notifications → first row', async () => {
    await goto(`${W}/notifications`);
    const first = await mainClickable();
    if (!first) return 'no clickable notification rows (empty state?)';
    await tap(first.loc, { timeout: 10000 });
    await sleep(2000);
    await shot('flow__notifications_row');
    return `clicked "${first.txt}" (${first.sel}) → ${page.url()}`;
  });
  await flow('Messages → open first conversation + send', async () => {
    const picked = await openFirstConversation();
    const box = page.getByPlaceholder('Message').first();
    await box.waitFor({ state: 'visible', timeout: 10000 });
    const msg = `QA crawl message ${stamp}`;
    await box.fill(msg);
    const sendBtn = page.getByRole('button', { name: /^send$/i });
    if (await sendBtn.count() && await sendBtn.first().isEnabled()) await tap(sendBtn.first(), { timeout: 5000 }); else await box.press('Enter');
    await page.getByText(msg, { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
    await shot('flow__messages_send');
    return `opened "${picked.txt}", sent and saw "${msg}"`;
  });
  await flow('Settings → each tab', async () => {
    await goto(`${W}/settings`);
    let tabs = page.locator('main [role=tab]');
    if (!(await tabs.count())) tabs = page.locator('main a[href*="tab="], main button').filter({ hasText: /general|notifications|members|lists|workspace|profile/i });
    const n = await tabs.count();
    const names = [];
    for (let i = 0; i < n; i++) {
      const t = tabs.nth(i);
      const nm = short(await t.innerText().catch(() => ''), 40);
      await tap(t, { timeout: 8000 }); await sleep(1500);
      names.push(`${nm}→${new URL(page.url()).search || '(no ?tab)'}`);
      await shot(`flow__settings_tab_${i}`);
    }
    if (!n) throw new Error('no tabs found on settings');
    return names.join('; ');
  });
  await flow('Command palette Ctrl/Meta+K', async () => {
    await goto(`${W}`);
    await page.keyboard.press('Control+k');
    const inp = page.getByLabel('Search tasks, navigate, or type a command');
    if (!(await inp.isVisible().catch(() => false))) { await page.keyboard.press('Meta+k'); }
    await inp.waitFor({ state: 'visible', timeout: 8000 });
    await inp.type('lease', { delay: 50 });
    await sleep(2000);
    await shot('flow__cmdk');
    const s = await snapshot();
    await page.keyboard.press('Escape');
    return `palette opened, typed "lease", dialogs=${s.dialogs}`;
  });
}

// ---------- main ----------
process.on('SIGTERM', () => { log('SIGTERM, flushing'); flush(); process.exit(1); });
process.on('unhandledRejection', e => log('unhandledRejection', e && e.message));
(async () => {
  log(`START out=${OUT} device=${DEVICE || 'desktop'} engine=${ENGINE}`);
  if (ENGINE === 'webkit') {
    try { browser = await webkit.launch({ headless: true }); }
    catch (err) {
      ENGINE = 'chromium';
      ENGINE_NOTE = `FALLBACK: real WebKit could not launch on this host (${short(err.message, 160)}); using Chromium with the ${DEV.name} device descriptor (same viewport/UA/touch), NOT a WebKit engine`;
      log(ENGINE_NOTE);
    }
  }
  if (!browser) browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  // Mobile: spread the Playwright device descriptor (viewport, deviceScaleFactor, isMobile, hasTouch, userAgent).
  context = await browser.newContext(MOBILE ? { ...DESC, ignoreHTTPSErrors: true } : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  log(deviceLine());
  await newPage();
  await login();
  for (const P of PAGES) {
    if (Date.now() - t0 > GLOBAL_BUDGET_MS) { log('GLOBAL BUDGET EXCEEDED, skipping remaining pages'); break; }
    try { await crawlPage(P); } catch (err) { log(`PAGE ${P.key} CRASHED: ${err.message}`); report.suspicious.push({ page: P.key, control: '(page)', reason: 'page crawl crashed: ' + short(err.message, 300) }); if (!page || page.isClosed()) await newPage(); }
  }
  await runFlows();
  if (MOBILE) await runMobileFlows();
  report.finishedAt = new Date().toISOString();
  flush();
  log(`DONE in ${Math.round((Date.now() - t0) / 1000)}s: ${report.pages.length} pages, ${report.pages.reduce((a, p) => a + p.results.length, 0)} clicks, ${report.flows.length} flows, ${report.suspicious.length} suspicious, ${report.skipped.length} skipped. Report: ${OUT}/report.md`);
  await browser.close();
  process.exit(0);
})().catch(async err => {
  log('FATAL', err.stack || err.message);
  try { flush(); } catch {}
  try { await browser?.close(); } catch {}
  process.exit(1);
});
