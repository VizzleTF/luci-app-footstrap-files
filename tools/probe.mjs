/* T2 for luci-app-footstrap-files: every operation the page offers, against a running router.
 *
 *   node tools/probe.mjs                       # the 25.12 stand on :8025
 *   FILES_BASE=http://localhost:8024 node tools/probe.mjs
 *
 * WHAT MAKES THIS A GATE RATHER THAN A CLICK-THROUGH: every assertion is read back from the ROUTER,
 * not from the page that just claimed success. The page saying "Saved." while the file on disk is
 * unchanged is the failure mode this package can actually have — it writes as root through four
 * different transports (ubus `file`, `fs.exec`, cgi-upload, cgi-download), and three of them can
 * fail in ways the browser never sees.
 *
 * The router is asked through the page's own session, with `fs.exec` on `/bin/ls` and `/bin/cat`:
 * a second channel (ssh, docker exec) would test a different router than the one the page is on
 * when the base URL points somewhere else.
 *
 * This package has no node_modules of its own, so playwright is borrowed from the theme's checkout
 * beside it, or from $PLAYWRIGHT. */
import { existsSync } from 'node:fs';

const CANDIDATES = [
	process.env.PLAYWRIGHT,
	new URL('../../luci-theme-footstrap/node_modules/playwright/index.mjs', import.meta.url).pathname,
	new URL('../node_modules/playwright/index.mjs', import.meta.url).pathname,
].filter(Boolean);
const found = CANDIDATES.find((p) => existsSync(p));
if (!found) {
	console.error('probe: playwright not found — set $PLAYWRIGHT, or keep a luci-theme-footstrap checkout beside this one');
	process.exit(2);
}
const { chromium } = await import(found);

const BASE = (process.env.FILES_BASE || 'http://localhost:8025') + '/cgi-bin/luci';
const DIR = '/tmp/fsf-probe';
let failed = 0;

function ok(name, cond, detail) {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
	if (!cond) failed++;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
let watching = false;
const pageErrors = [];
/* MEASURED FROM THE APP'S PAGE, not from the login hop. luci-base asks for `uci get luci` while the
 * login redirect is in flight and is refused there — 3 logins out of 3 on a stand brought up fresh,
 * and never once on this page or on Status. Counting it here would make this gate report somebody
 * else's call. */
page.on('pageerror', (e) => { if (watching) pageErrors.push(String(e).split('\n')[0].slice(0, 120)); });
/* prompt() and confirm() drive rename, mkdir and the recursive delete; answering them here is what
 * a reader does, and refusing to answer would leave the page waiting for ever. */
page.on('dialog', (d) => {
	const q = d.message();
	if (d.type() === 'confirm') return d.accept();
	if (q.includes('directory name')) return d.accept('sub');
	if (q.includes('file name')) return d.accept('made.txt');
	if (/^Rename/.test(q)) return d.accept('renamed.txt');
	return d.accept('');
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
if (await page.$('input[name="luci_password"]')) {
	await page.fill('input[name="luci_username"]', 'root');
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		page.press('input[name="luci_password"]', 'Enter'),
	]);
}

/* The router's own answer, through the session the page already holds. */
const onRouter = (cmd, args) => page.evaluate(async ([ c, a ]) => {
	const fs = await L.require('fs');
	const r = await fs.exec(c, a);
	return { code: r.code, out: (r.stdout || '').trim() };
}, [ cmd, args ]);

const at = async (path) => {
	await page.goto(`${BASE}/admin/system/footstrap-files#${encodeURIComponent(path)}`, { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(2500);
};
const names = () => page.evaluate(() => [ ...document.querySelectorAll('.table .tr .td:nth-child(2)') ].map((e) => e.textContent.trim()));
/* The toolbar draws icons, so its buttons are addressed by the name they carry for a screen
 * reader rather than by their text. */
const bar = (label) => page.locator('.fsf-bar [aria-label="' + label + '"]').first().click();
const rowButton = (row, label) => page.locator('.tr', { hasText: row }).first().locator('[aria-label="' + label + '"]').click();
/* SELECTING IS A MODE. One tap opens now, so a tick is not a checkbox the probe can check: it enters
 * the mode the way a reader does — the row's own menu, "Select" — and leaves it first if a previous
 * step left it on, so each pick starts from a known selection. */
const pick = async (name) => {
	if (await page.locator('.fsf-selcount').count() > 0) {
		await page.locator('.fsf-bar [aria-label="Done"]').click();
		await page.waitForTimeout(500);
	}
	await page.locator('.tr', { hasText: name }).first().dispatchEvent('contextmenu', { clientX: 300, clientY: 300 });
	await page.waitForTimeout(500);
	await page.locator('.fsf-menu-item').filter({ hasText: /^Select$/ }).first().click();
	await page.waitForTimeout(800);
};

watching = true;
await onRouter('/bin/rm', [ '-rf', '--', DIR ]);
await onRouter('/bin/mkdir', [ '-p', '--', DIR ]);
await at(DIR);

ok('the page renders a listing', (await page.locator('.table .tr.table-titles').count()) === 1);

/* ---- create ---------------------------------------------------------------------------------- */
await bar('New folder'); await page.waitForTimeout(2000);
ok('mkdir', (await onRouter('/bin/ls', [ '-d', '--', `${DIR}/sub` ])).code === 0);

await bar('New file'); await page.waitForTimeout(2000);
ok('new file', (await onRouter('/bin/ls', [ '--', `${DIR}/made.txt` ])).code === 0);

/* ---- rename ---------------------------------------------------------------------------------- */
await rowButton('made.txt', 'Rename'); await page.waitForTimeout(2000);
ok('rename', (await onRouter('/bin/ls', [ '--', `${DIR}/renamed.txt` ])).code === 0);

/* ---- edit and save --------------------------------------------------------------------------- */
await rowButton('renamed.txt', 'Edit'); await page.waitForTimeout(5000);
ok('the editor opens', (await page.locator('.fsf-editor textarea').count()) > 0);
await page.locator('.fsf-editor textarea').first().click();
await page.keyboard.type('written by the probe');
await page.locator('button', { hasText: 'Save' }).first().click();
await page.waitForTimeout(2500);
const saved = await onRouter('/bin/cat', [ '--', `${DIR}/renamed.txt` ]);
ok('save reaches the file', saved.out.includes('written by the probe'), saved.out.slice(0, 40));
await page.locator('button', { hasText: 'Close' }).first().click();
await page.waitForTimeout(1000);

/* ---- permissions and owner -------------------------------------------------------------------- */
await rowButton('renamed.txt', 'Properties'); await page.waitForTimeout(1500);
await page.locator('.modal input[type=text]').first().fill('600');
await page.locator('.modal input[type=text]').nth(1).fill('nobody:nogroup');
await page.locator('.modal button', { hasText: 'Apply' }).click();
/* WAIT FOR THE LISTING, NOT FOR A CLOCK. Applying properties ends in a refresh, and a refresh
 * rebuilds the rows and clears the selection — so a tick placed while it is in flight is thrown
 * away and the next step reports "nothing selected" for a reason that has nothing to do with it. */
await page.locator('.tr', { hasText: 'renamed.txt' }).first()
	.locator('.fsf-mode', { hasText: '-rw-------' }).waitFor({ timeout: 15000 });
const stat = await onRouter('/bin/ls', [ '-l', '--', `${DIR}/renamed.txt` ]);
ok('chmod', stat.out.startsWith('-rw-------'), stat.out.slice(0, 40));
ok('chown', /nobody/.test(stat.out) && /nogroup/.test(stat.out), stat.out.slice(0, 40));

/* ---- copy into a subdirectory, then move it back ---------------------------------------------- */
await pick('renamed.txt');
await bar('Copy');
/* A FULL CLIPBOARD TAKES THE TOOLBAR: the count appears in the bar itself, beside the path, and
 * Paste here is one of its buttons. If the mark did not take, say WHY rather than time out — the
 * page's own notification is the answer, and "Nothing selected" means a refresh landed between the
 * tick and the button. */
await page.locator('.fsf-clipcount', { hasText: 'to copy' }).waitFor({ timeout: 10000 }).catch(async () => {
	const note = (await page.locator('body').innerText()).match(/Nothing selected[^\n]*|Cannot[^\n]*/g);
	ok('copy marks the clipboard', false, note ? note.join(' | ') : 'no notification either');
});
await at(`${DIR}/sub`);
await bar('Paste here'); await page.waitForTimeout(2500);
const copied = await onRouter('/bin/ls', [ '-l', '--', `${DIR}/sub/renamed.txt` ]);
ok('copy', copied.code === 0);
ok('copy keeps the mode (cp -a)', copied.out.startsWith('-rw-------'), copied.out.slice(0, 40));

await pick('renamed.txt');
await bar('Move');
await page.locator('.fsf-clipcount', { hasText: 'to move' }).waitFor({ timeout: 10000 });
/* UP, not the last breadcrumb — that one is the directory we are already in, and pasting there is
 * refused on purpose ("source and destination are the same directory"). */
await bar('Up'); await page.waitForTimeout(2000);
/* A NAME THAT IS ALREADY TAKEN. The original is still here, so this paste must refuse rather than
 * overwrite — and it must SAY so: both `cp -n` and `mv -n` skip silently with exit 0. */
await bar('Paste here'); await page.waitForTimeout(2500);
ok('a paste onto an existing name is refused', (await onRouter('/bin/ls', [ '--', `${DIR}/sub/renamed.txt` ])).code === 0);
/* The notification is NOT inside #view: ui.addNotification puts it in luci-base's own container
 * above the page, which is where a reader looks and where this assertion has to look too. */
ok('and the reader is told', /already here/i.test(await page.locator('body').innerText()));

/* …and the same move into a directory where the name is free */
await onRouter('/bin/mkdir', [ '-p', '--', `${DIR}/dest` ]);
await at(`${DIR}/sub`);
await pick('renamed.txt');
await bar('Move');
await page.locator('.fsf-clipcount', { hasText: 'to move' }).waitFor({ timeout: 10000 });
await at(`${DIR}/dest`);
await bar('Paste here'); await page.waitForTimeout(2500);
ok('move leaves nothing behind', (await onRouter('/bin/ls', [ '--', `${DIR}/sub/renamed.txt` ])).code !== 0);
ok('move puts it where the reader was', (await onRouter('/bin/ls', [ '--', `${DIR}/dest/renamed.txt` ])).code === 0);

/* ---- upload and download ----------------------------------------------------------------------- */
/* back where the probe started, and asserted rather than assumed: everything below checks paths
 * under DIR, so a page left in a subdirectory would test the wrong directory and pass. */
await at(DIR);
await page.setInputFiles('.fsf-bar input[type=file]', {
	name: 'uploaded.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded by the probe\n'),
});
await page.waitForTimeout(3000);
const up = await onRouter('/bin/cat', [ '--', `${DIR}/uploaded.txt` ]);
ok('upload', up.out.includes('uploaded by the probe'), up.out.slice(0, 40));

const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
await rowButton('uploaded.txt', 'Download');
const file = await dl;
ok('download', !!file, file ? await file.suggestedFilename() : 'no download event');

/* ---- delete ------------------------------------------------------------------------------------ */
await pick('uploaded.txt');
/* In select mode the toolbar IS the selection's, so the button is "Delete" — the "Delete selected"
 * of the ordinary toolbar is a different button, and it is not on screen while selecting. */
await bar('Delete'); await page.waitForTimeout(2500);
ok('delete', (await onRouter('/bin/ls', [ '--', `${DIR}/uploaded.txt` ])).code !== 0);

/* A directory with something in it: ubus refuses, and the page turns that into a question rather
 * than an error the reader cannot act on. */
await rowButton('sub', 'Delete'); await page.waitForTimeout(3500);
ok('recursive delete after the refusal', (await onRouter('/bin/ls', [ '-d', '--', `${DIR}/sub` ])).code !== 0);

/* ---- the tile view ------------------------------------------------------------------------------ */
/* `sub` was deleted by the recursive-delete check above, and the three below need a directory to
 * right-click and to drop onto. */
await onRouter('/bin/mkdir', [ '-p', '--', `${DIR}/sub` ]);
await at(DIR);
/* The directory was made behind the page's back, and `at()` only rewrites a fragment the page is
 * already on — which changes nothing. Refresh is the page's own way to re-read the directory. */
await bar('Refresh'); await page.waitForTimeout(2000);
await bar('Tiles');
await page.waitForTimeout(1200);
ok('the tile view draws tiles', (await page.locator('.fsf-grid .fsf-tile').count()) > 0);
ok('and no table', (await page.locator('.fsf-listing table.table').count()) === 0);

/* the choice survives a reload — it is stored per browser, not per session */
await at(DIR);
ok('the view mode is remembered', (await page.locator('.fsf-grid').count()) === 1);
await bar('List');
await page.waitForTimeout(1200);
ok('and switching back gives the table', (await page.locator('.fsf-listing table.table').count()) === 1);

/* ---- the context menu --------------------------------------------------------------------------- */
await page.locator('.tr', { hasText: 'sub' }).first().dispatchEvent('contextmenu', { clientX: 200, clientY: 200 });
await page.waitForTimeout(600);
const menuItems = await page.locator('.fsf-menu .fsf-menu-item').allInnerTexts();
ok('right-click opens a menu', menuItems.length > 0, menuItems.join(', '));
ok('a directory offers Open, not Download', menuItems.includes('Open') && !menuItems.includes('Download'));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('Escape closes it', (await page.locator('.fsf-menu').count()) === 0);

/* The phone's way into that menu: iOS Safari fires no `contextmenu` at all, so a 500 ms press is
 * the only opening. Synthesised here rather than driven through page.touchscreen, which taps and
 * cannot hold. */
const press = (hold, drift) => page.evaluate(async ([ hold, drift ]) => {
	const el = Array.from(document.querySelectorAll('.tr.fsf-row')).find(r => r.textContent.indexOf('sub') === 0);
	const r = el.getBoundingClientRect();
	const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
	const mk = (type, cx, cy) => {
		const t = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy });
		const list = type === 'touchend' ? [] : [ t ];
		return new TouchEvent(type, { touches: list, targetTouches: list, changedTouches: [ t ], bubbles: true, cancelable: type === 'touchend' });
	};
	el.dispatchEvent(mk('touchstart', x, y));
	if (drift) el.dispatchEvent(mk('touchmove', x + drift, y));
	await new Promise(r => setTimeout(r, hold));
	const end = mk('touchend', x, y);
	el.dispatchEvent(end);
	await new Promise(r => setTimeout(r, 200));
	return { menu: !!document.querySelector('.fsf-menu'), suppressed: end.defaultPrevented };
}, [ hold, drift ]);

const held = await press(700, 0);
ok('a 700 ms press opens the same menu', held.menu);
ok('and eats the click that follows', held.suppressed);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
ok('a 150 ms tap does not', !(await press(150, 0)).menu);
ok('nor does a press that drifts 40 px', !(await press(700, 40)).menu);

/* THE PRESS MUST SURVIVE A SUSPENDED TIMER. iOS holds JS timers while a scroll and its momentum
 * run, so on a real iPhone the menu did not open at all after scrolling; the release path reads the
 * elapsed time itself. Here the 500 ms timer is simply never allowed to fire. */
const frozen = (hold) => page.evaluate(async (hold) => {
	const real = window.setTimeout;
	window.setTimeout = function (fn, ms) { return ms === 500 ? 0 : real.apply(window, arguments); };
	const el = [ ...document.querySelectorAll('.tr.fsf-row') ].find(r => r.textContent.indexOf('sub') === 0);
	const r = el.getBoundingClientRect();
	const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
	const mk = (type) => {
		const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
		const l = type === 'touchend' ? [] : [ t ];
		return new TouchEvent(type, { touches: l, targetTouches: l, changedTouches: [ t ], bubbles: true, cancelable: type === 'touchend' });
	};
	el.dispatchEvent(mk('touchstart'));
	await new Promise(r => real(r, hold));
	const end = mk('touchend');
	el.dispatchEvent(end);
	await new Promise(r => real(r, 200));
	const out = { menu: !!document.querySelector('.fsf-menu'), suppressed: end.defaultPrevented };
	window.setTimeout = real;
	const m = document.querySelector('.fsf-menu');
	if (m) m.remove();
	return out;
}, hold);
ok('a held press opens on release when the timer never fired', (await frozen(700)).menu);
ok('and a short one still does not', !(await frozen(150)).menu);

/* ---- one tap opens, and selecting is a mode ------------------------------------------------------- */
/* `at()` is a SAME-DOCUMENT navigation when only the fragment differs — which is what makes the
 * clipboard survive it above, and what means the page arrives here in whatever state the previous
 * section left: select mode on from `pick()`, and a modal still up. Both are cleared explicitly,
 * because a click that lands on a modal overlay reads exactly like a click that did nothing. */
await at(DIR);
/* VISIBLE, not merely present: luci-base keeps `#modal_overlay` in the document with the last
 * modal still inside it, so counting `.modal` finds one on a page that shows none. */
const openModal = page.locator('.modal').first();
if (await openModal.count() && await openModal.isVisible()) {
	const close = page.locator('.modal button').filter({ hasText: /Close|Cancel|Dismiss/ }).first();
	if (await close.count()) await close.click(); else await page.keyboard.press('Escape');
	await page.waitForTimeout(800);
}
if (await page.locator('.fsf-selcount').count()) {
	await page.locator('.fsf-bar [aria-label="Done"]').click();
	await page.waitForTimeout(500);
}
await bar('Refresh'); await page.waitForTimeout(1500);
await page.locator('.tr.fsf-row', { hasText: 'sub' }).first().click();
await page.waitForTimeout(2000);
const opened = await page.evaluate(() => decodeURIComponent(location.hash));
ok('a single click opens a directory', opened.endsWith('/sub'), opened);
await bar('Up'); await page.waitForTimeout(2000);

/* Two files to select between; `renamed.txt` was moved away by the move check above. */
await onRouter('/bin/sh', [ '-c', `printf one > ${DIR}/one.txt; printf two > ${DIR}/two.txt` ]);
await bar('Refresh'); await page.waitForTimeout(1500);

await page.locator('.tr.fsf-row', { hasText: 'one.txt' }).first().click({ modifiers: [ 'Control' ] });
await page.waitForTimeout(800);
ok('Ctrl+click selects without opening', (await page.locator('.fsf-row.fsf-sel').count()) === 1);
ok('and the mode turns itself on', (await page.locator('.fsf-selcount').count()) === 1);

await page.locator('.tr.fsf-row', { hasText: 'two.txt' }).first().click({ modifiers: [ 'Shift' ] });
await page.waitForTimeout(800);
const ranged = await page.locator('.fsf-row.fsf-sel').count();
ok('Shift+click takes the range', ranged >= 2, String(ranged));

await page.locator('.fsf-bar [aria-label="Done"]').click();
await page.waitForTimeout(800);
ok('Done leaves the mode and the selection', (await page.locator('.fsf-selcount').count()) === 0 && (await page.locator('.fsf-row.fsf-sel').count()) === 0);

await pick('one.txt');
ok("the menu's Select enters the mode with that file ticked", (await page.locator('.fsf-row.fsf-sel').count()) === 1);
await page.locator('.tr.fsf-row', { hasText: 'two.txt' }).first().click();
await page.waitForTimeout(600);
ok('and a plain click then ticks instead of opening', (await page.locator('.fsf-row.fsf-sel').count()) === 2);
/* SELECT MODE OWNS THE TOOLBAR: one bar, not two, so nothing appears above the listing and pushes
 * it down while the reader is ticking. */
ok('the mode takes the toolbar over', (await page.locator('.fsf-bar [aria-label="New folder"]').count()) === 0
	&& (await page.locator('.fsf-bar [aria-label="Done"]').count()) === 1);
/* Ticking redraws nothing but the classes, so the document keeps its height and the page keeps its
 * scroll — the jump that made selecting several files unusable on a phone. */
const jump = await page.evaluate(async () => {
	window.scrollTo(0, 120);
	await new Promise(r => setTimeout(r, 300));
	const before = window.scrollY, h = document.documentElement.scrollHeight;
	const row = document.querySelectorAll('.tr.fsf-row')[2];
	row.click();
	await new Promise(r => setTimeout(r, 400));
	const out = { moved: Math.abs(window.scrollY - before), grew: Math.abs(document.documentElement.scrollHeight - h) };
	/* ticked back off: the next assertion deletes the selection, and this row is not part of it */
	row.click();
	await new Promise(r => setTimeout(r, 300));
	return out;
});
ok('ticking moves neither the scroll nor the page height', jump.moved === 0 && jump.grew === 0, JSON.stringify(jump));
await page.locator('.fsf-bar [aria-label="Delete"]').click();
await page.waitForTimeout(2500);
ok('the bar deletes what was ticked',
	(await onRouter('/bin/ls', [ '--', `${DIR}/one.txt` ])).code !== 0 &&
	(await onRouter('/bin/ls', [ '--', `${DIR}/two.txt` ])).code !== 0);

/* ---- dropping a file onto a folder --------------------------------------------------------------- */
const dt = await page.evaluateHandle(() => {
	const d = new DataTransfer();
	d.items.add(new File([ 'dropped by the probe\n' ], 'dropped.txt', { type: 'text/plain' }));
	return d;
});
await page.locator('.tr', { hasText: 'sub' }).first().dispatchEvent('drop', { dataTransfer: dt });
await page.waitForTimeout(3500);
const dropped = await onRouter('/bin/cat', [ '--', `${DIR}/sub/dropped.txt` ]);
ok('a file dropped on a folder lands in it', dropped.out.includes('dropped by the probe'), dropped.out.slice(0, 40));

/* ---- the page itself ---------------------------------------------------------------------------- */
ok('nothing was added to <head>', await page.evaluate(() =>
	![ ...document.head.querySelectorAll('style, link[rel="stylesheet"]') ]
		.some((s) => (s.textContent || s.href || '').includes('pce') || (s.textContent || '').includes('.pce-'))));
ok('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

await onRouter('/bin/rm', [ '-rf', '--', DIR ]);
await browser.close();

console.log(`\n${failed ? failed + ' failed' : 'all checks passed'} — ${BASE}`);
process.exit(failed ? 1 : 0);
