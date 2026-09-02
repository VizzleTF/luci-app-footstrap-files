/* What this package's stylesheets are allowed to read, and what they must not leave behind.
 *
 * THREE CHECKS, all of them rules this repository already states in prose and nothing enforced:
 *
 *   1. THE EXPORT TIER. Colour comes from the 26 `--*-color-*` names every LuCI theme publishes
 *      (luci-theme-footstrap docs/luci-app-styling-guide.md §3.1) — never from footstrap's own
 *      `--fs-*`, which is its PRIVATE tier: renamed whenever it wants and absent from every other
 *      theme. A `var(--fs-anything)` here is a package that looks right on one theme and wrong on
 *      the rest. Names that do not exist anywhere (`--warning-color-*`, `--text-color` with no
 *      level, `--font-mono`) are the same bug with an extra step: they always fall through to the
 *      literal, so the fallback is the only thing that ever paints.
 *
 *   2. NO ORPHANS. A `.fsf-*` class in a sheet that nothing in the JS ever puts on an element is
 *      dead weight — and, more often, a rename that only landed on one side.
 *
 *   3. NOTHING REACHES OUT. No `@import`, no `url(http…)`: a stylesheet that fetches from the
 *      network is a router page phoning somewhere on a device whose whole point is that it does
 *      not.
 *
 * The vendored CSS is not checked: it is prism-code-editor's, it ships verbatim, and its variables
 * are its own contract with itself. */
import { readFileSync, readdirSync } from 'node:fs';

const VIEW = 'luci-app-footstrap-files/htdocs/luci-static/resources/view/footstrap-files';

/* The whole contract, from the guide. Nothing else is one. */
const TIER = new Set([
	'--background-color-high', '--background-color-medium', '--background-color-low',
	'--border-color-high', '--border-color-medium', '--border-color-low',
	'--text-color-highest', '--text-color-high', '--text-color-medium', '--text-color-low',
	'--primary-color-high', '--primary-color-medium', '--primary-color-low', '--on-primary-color',
	'--success-color-high', '--success-color-medium', '--success-color-low', '--on-success-color',
	'--warn-color-high', '--warn-color-medium', '--warn-color-low', '--on-warn-color',
	'--error-color-high', '--error-color-medium', '--error-color-low', '--on-error-color',
]);

const sheets = readdirSync(VIEW).filter((f) => f.endsWith('.css'));
const scripts = readdirSync(VIEW).filter((f) => f.endsWith('.js'));
const js = scripts.map((f) => readFileSync(`${VIEW}/${f}`, 'utf8')).join('\n');

let bad = 0;
const fail = (m) => { console.error('FAIL  ' + m); bad++; };

for (const name of sheets) {
	const raw = readFileSync(`${VIEW}/${name}`, 'utf8');
	const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

	/* 1. what it READS against what it may read, plus what it declares itself */
	const declared = new Set([ ...css.matchAll(/^\s*(--[\w-]+)\s*:/gm) ].map((m) => m[1]));
	for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
		const v = m[1];
		if (TIER.has(v) || declared.has(v)) continue;
		if (v.startsWith('--fs-'))
			fail(`${name}: reads ${v} — footstrap's PRIVATE tier, renamed whenever it wants`);
		else
			fail(`${name}: reads ${v} — not one of the 26 export names and not declared here`);
	}

	/* 2. every `.fsf-*` the sheet styles has to be a class the page actually sets */
	for (const cls of new Set([ ...css.matchAll(/\.(fsf-[\w-]+)/g) ].map((m) => m[1])))
		if (!js.includes(cls)) fail(`${name}: .${cls} is styled and never set`);

	/* 3. nothing leaves the router */
	if (/@import/.test(css)) fail(`${name}: @import — a page on a router fetches nothing`);
	for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)/g))
		if (/^(https?:)?\/\//.test(m[1])) fail(`${name}: url(${m[1]}) reaches the network`);
}

if (bad) process.exit(1);
console.log(`css-contract: ${sheets.length} sheet(s) — export tier only, no orphans, nothing remote`);
