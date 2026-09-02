/* Minify the VENDORED editor over the staged payload — as ES modules, never in the checkout.
 *
 *   node tools/minify-vendor.mjs dist/root/www/luci-static/resources/view/footstrap-files/vendor/pce
 *
 * WHY THIS IS NOT "EDITING SOMEBODY ELSE'S CODE". prism-code-editor ships its dist through rollup
 * with code-splitting and NO minifier: the files carry their JSDoc, their indentation and their line
 * breaks — 74,142 bytes of JS where terser reaches 30,219. The tree in the repository stays exactly
 * as upstream published it, which is what makes a diff against a new release readable; what ships is
 * the same code with the whitespace taken out, the way the OpenWrt buildbot treats every other
 * package's JS.
 *
 * THE MODULE SEAM IS THE WHOLE RISK, and it is checked rather than trusted. These files import each
 * other by name across 25 modules (`import { a as languages } from "./core-DEy9UQvI.js"`), so a
 * mangled export would leave a module importing a name nobody exports any more — and nothing would
 * say so until a reader opened a file on a router. Every file's import and export lists are
 * therefore compared before and after, source by source and name by name, and a file whose seam
 * moved is not written.
 *
 * `mangle.toplevel` is safe for the same reason it is safe for our own modules: a module's top level
 * is its own scope, and terser rewrites the export specifier along with the binding it renames. The
 * external half of `export { x as a }` — the `a` — is what other files import, and it survives.
 *
 * Verified on the stand with the packaged bytes: the editor opens, uci highlights, find-and-replace
 * counts its matches, and T2 passes 44/44. */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as acorn from 'acorn';
import { minify } from 'terser';

const ACORN = { ecmaVersion: 2022, sourceType: 'module' };

const root = process.argv[2];
if (!root) {
	console.error('usage: node tools/minify-vendor.mjs <staged vendor dir>');
	process.exit(2);
}

const files = [];
const walk = (p) => statSync(p).isDirectory() ? readdirSync(p).forEach((f) => walk(join(p, f))) : p.endsWith('.js') && files.push(p);
walk(root);
if (!files.length) {
	console.error(`minify-vendor: no .js under ${root} — the vendored editor is not where it was staged`);
	process.exit(1);
}

/* What this file asks of other files, and what it offers them, as the OTHER side sees it: the
 * source of every import, the external name of every imported and re-exported binding, and the
 * external name of every export. Local names are terser's business; these are not. */
function seam(src) {
	const ast = acorn.parse(src, ACORN);
	const out = [];
	for (const n of ast.body) {
		if (n.type === 'ImportDeclaration')
			out.push('import ' + n.source.value + ' {' + n.specifiers.map((s) => s.imported ? s.imported.name : (s.type === 'ImportDefaultSpecifier' ? 'default' : '*')).sort().join(',') + '}');
		else if (n.type === 'ExportNamedDeclaration')
			out.push('export ' + (n.source ? n.source.value + ' ' : '') + '{' + n.specifiers.map((s) => s.exported.name).sort().join(',') + '}');
		else if (n.type === 'ExportAllDeclaration')
			out.push('export * ' + n.source.value);
		else if (n.type === 'ExportDefaultDeclaration')
			out.push('export default');
	}
	return out.sort().join('|');
}

let before = 0, after = 0, failed = 0;
for (const f of files) {
	const name = relative(root, f);
	const src = readFileSync(f, 'utf8');
	const res = await minify(src, {
		module: true,
		compress: { passes: 3 },
		mangle: { toplevel: true },
		format: { comments: false },
	});
	const min = res.code;
	try {
		acorn.parse(min, ACORN);
		const was = seam(src), now = seam(min);
		if (was !== now)
			throw new Error(`the module seam moved\n    was: ${was}\n    now: ${now}`);
		if (!min || min.length >= src.length)
			throw new Error(`implausible output size ${min && min.length} (source ${src.length})`);
	} catch (e) {
		console.log(`  FAIL ${name}: ${e.message}`);
		failed++;
		continue;
	}
	writeFileSync(f, min);
	before += src.length; after += min.length;
}

console.log(`minify-vendor: ${before} -> ${after} bytes (${before ? Math.round(100 - after * 100 / before) : 0}% smaller), ${files.length} files`);
if (failed) {
	console.error(`minify-vendor: ${failed} file(s) failed verification — refusing to ship`);
	process.exit(1);
}
