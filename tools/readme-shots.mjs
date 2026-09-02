/* The README's screenshots, taken off an owlab stand rather than off anybody's router.
 *
 *   node tools/readme-shots.mjs                     # the 25.12 stand on :8025
 *   FILES_BASE=http://localhost:8024 node tools/readme-shots.mjs
 *
 * WHY A SCRIPT AND NOT A SCREENSHOT KEY. A README picture is a claim about what the page looks like
 * today, and the one thing worse than no picture is one from three versions ago. This takes them
 * again in one command, from a stand that is built from the packaged bytes.
 *
 * NOTHING PERSONAL IS IN FRAME, by construction rather than by retouching: the shot is cropped to
 * the page's own listing or dialog, so no hostname, address bar, menu or LuCI header is captured;
 * the files are made here, in /tmp on a throwaway container; and the one real file shown —
 * /etc/config/network — is the stand's untouched default.
 *
 * Both themes, because GitHub serves the README in whichever the reader is using and a light-only
 * picture on a dark page is a bright rectangle. The theme keeps that choice in localStorage, so it
 * is asked for there.
 *
 * playwright is borrowed from the theme's checkout beside this one, exactly as tools/probe.mjs does. */
import { existsSync, mkdirSync } from 'node:fs';

const CANDIDATES = [
	process.env.PLAYWRIGHT,
	new URL('../../luci-theme-footstrap/node_modules/playwright/index.mjs', import.meta.url).pathname,
	new URL('../node_modules/playwright/index.mjs', import.meta.url).pathname,
].filter(Boolean);
const found = CANDIDATES.find((p) => existsSync(p));
if (!found) {
	console.error('readme-shots: playwright not found — set $PLAYWRIGHT, or keep a luci-theme-footstrap checkout beside this one');
	process.exit(2);
}
const { chromium } = await import(found);

const BASE = (process.env.FILES_BASE || 'http://localhost:8025') + '/cgi-bin/luci';
const OUT = new URL('../assets/readme/', import.meta.url).pathname;
const DEMO = '/tmp/fsf-demo';
mkdirSync(OUT, { recursive: true });

/* A directory that shows what the icons are FOR: one of each family, two directories, and a symlink.
 * Sizes are written so the listing does not read as a grid of zeroes, and there are enough tiles for
 * three rows: the menu is opened over a tile in the FIRST row and unfolds downwards, and a grid
 * shorter than the menu would have it cropped by the screenshot's own bounds. */
const MAKE = [
	`mkdir -p ${DEMO}/config ${DEMO}/backups`,
	`dd if=/dev/urandom of=${DEMO}/backup.tar.gz bs=1k count=412 2>/dev/null`,
	`dd if=/dev/urandom of=${DEMO}/firmware.bin bs=1k count=7680 2>/dev/null`,
	`dd if=/dev/urandom of=${DEMO}/topology.png bs=1k count=63 2>/dev/null`,
	`dd if=/dev/urandom of=${DEMO}/luci-app-example.ipk bs=1k count=48 2>/dev/null`,
	`dd if=/dev/urandom of=${DEMO}/floorplan.jpg bs=1k count=204 2>/dev/null`,
	`head -c 2400 /etc/config/network > ${DEMO}/nikki.yaml`,
	`head -c 860 /etc/config/firewall > ${DEMO}/watchdog.sh`,
	`head -c 1200 /etc/config/dhcp > ${DEMO}/leases.json`,
	`head -c 640 /etc/config/dhcp > ${DEMO}/dnsmasq.conf`,
	`head -c 1500 /etc/config/wireless > ${DEMO}/radio.ini`,
	`head -c 320 /etc/config/system > ${DEMO}/collect.lua`,
	`head -c 980 /etc/config/firewall > ${DEMO}/rules.py`,
	`printf 'checked the ruleset on 12/03\n' > ${DEMO}/notes`,
	`head -c 220 /etc/banner > ${DEMO}/motd`,
	`ln -sf /etc/config ${DEMO}/etc-config`,
];

const browser = await chromium.launch();

for (const dark of [ false, true ]) {
	const suffix = dark ? 'dark' : 'light';
	const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 }, deviceScaleFactor: 2 });
	/* the theme reads the reader's choice from localStorage; `false` is not the same as unset —
	 * unset means "follow the system", which a headless browser reports as light anyway */
	await ctx.addInitScript(([ d ]) => {
		try { localStorage.setItem('fs-darkmode', d ? 'true' : 'false'); } catch (e) {}
	}, [ dark ]);
	const page = await ctx.newPage();

	await page.goto(BASE, { waitUntil: 'domcontentloaded' });
	if (await page.$('input[name="luci_password"]')) {
		await page.fill('input[name="luci_username"]', 'root');
		await Promise.all([
			page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
			page.press('input[name="luci_password"]', 'Enter'),
		]);
	}
	await page.evaluate(async (cmds) => {
		const fs = await L.require('fs');
		for (const c of cmds) await fs.exec('/bin/sh', [ '-c', c ]);
	}, MAKE);

	/* ---- the tiles ---- */
	await page.evaluate(() => localStorage.setItem('fsf-view', 'grid'));
	await page.goto(`${BASE}/admin/system/footstrap-files#${encodeURIComponent(DEMO)}`, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.fsf-grid', { timeout: 15000 });
	await page.waitForTimeout(1500);
	/* The toolbar and the context menu belong in this picture: they are the two things a reader
	 * cannot guess from a grid of icons. The menu is opened the way a mouse opens it, from the
	 * tile's own corner, so it unfolds downwards over the rows below rather than off the crop. */
	const tile = await page.locator('.fsf-tile', { hasText: 'dnsmasq.conf' }).first().boundingBox();
	await page.locator('.fsf-tile', { hasText: 'dnsmasq.conf' }).first().dispatchEvent('contextmenu', {
		clientX: Math.round(tile.x + tile.width - 8), clientY: Math.round(tile.y + tile.height - 8),
	});
	await page.waitForSelector('.fsf-menu', { timeout: 5000 });
	await page.waitForTimeout(500);
	await page.locator('.fsf').screenshot({ path: `${OUT}tiles-${suffix}.png` });
	console.log(`assets/readme/tiles-${suffix}.png`);

	/* ---- the editor, with the search widget open over highlighted uci ---- */
	await page.evaluate(() => localStorage.setItem('fsf-view', 'list'));
	/* A goto that changes only the FRAGMENT does not reload, and the view mode is read once per
	 * render — without the reload the page would still be drawing tiles and there would be no
	 * `.tr` to click. */
	await page.goto(`${BASE}/admin/system/footstrap-files#${encodeURIComponent('/etc/config')}`, { waitUntil: 'domcontentloaded' });
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.table .tr.fsf-row', { timeout: 15000 });
	await page.waitForTimeout(1500);
	await page.locator('.tr', { hasText: 'network' }).first().locator('[aria-label="Edit"]').click();
	await page.waitForSelector('.fsf-modal-actions', { timeout: 15000 });
	/* the editor fetches its modules on first open; the highlighting is what this shot is about */
	await page.waitForSelector('.prism-code-editor .token', { timeout: 15000 });
	await page.waitForTimeout(1200);
	await page.locator('.fsf-find').click();
	await page.waitForTimeout(500);
	await page.keyboard.type('interface');
	await page.waitForTimeout(800);
	await page.locator('.modal.fsf-modal-dialog').screenshot({ path: `${OUT}editor-${suffix}.png` });
	console.log(`assets/readme/editor-${suffix}.png`);

	await page.evaluate(async (d) => { const fs = await L.require('fs'); await fs.exec('/bin/rm', [ '-rf', '--', d ]); }, DEMO);
	await ctx.close();
}

await browser.close();
console.log('readme-shots: 4 files in assets/readme/');
