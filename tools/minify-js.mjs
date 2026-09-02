/* Pre-minify this package's own JS with terser, in place, over the STAGED payload.
 *
 * terser rather than jsmin: jsmin strips comments and whitespace only, while identifiers are wire
 * bytes and uhttpd serves /www with no compression. This page is a 65 KB module whose comments are
 * half its size, and every reader who opens System → Files pays for all of it.
 *
 * Top-level mangling is safe BECAUSE a LuCI resource file is evaluated inside a function wrapper:
 * its top level is function scope, and everything crossing a module seam goes through the wrapper's
 * parameters (`L`, the require aliases) or through globals (`E`, `_`), which terser never renames.
 *
 * IT NEVER RUNS OVER THE CHECKOUT and it never runs over `vendor/`: the caller hands it the staged
 * copy of the view's own directory, and the vendored editor beside it is third-party ES-module code
 * shipped verbatim, already minified by its own build, and not ours to rewrite. It rewrites every
 * file it is handed in place.
 *
 * The SDK path is untouched and still runs jsmin (LUCI_MINIFY_JS is left at its default), which is
 * what tools/t0.sh gates. The two paths therefore ship different bytes for the same commit — the
 * price of the SDK having no node — and both are checked: t0.sh parses the jsmin output, this file
 * parses its own.
 *
 * THE SEAM NAMES ARE RESERVED, AND THE LIST IS DERIVED. Terser never RENAMES a free variable like
 * `L`, but it will happily CREATE one: handed the file on its own, it takes the top level for
 * global scope and `L` for a name nobody declared, i.e. one it may give to a mangled variable. So
 * the free variables of the SOURCE are reserved, computed per file rather than listed — a new seam
 * name cannot be forgotten because nothing here names them. Adapted from luci-theme-footstrap's
 * tools/minify-js.mjs; bump them together. */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import * as acorn from 'acorn';
import { minify } from 'terser';

const ACORN = { ecmaVersion: 2022, allowReturnOutsideFunction: true };

const roots = process.argv.slice(2);
if (!roots.length) {
	console.error('usage: node tools/minify-js.mjs <dir-or-file.js> ...');
	process.exit(2);
}

const files = [];
const walk = (p) => {
	const st = statSync(p);
	/* `vendor/` is skipped by NAME rather than by handing this a file list: a directory is what the
	 * caller passes, and a new vendored tree under it must not become ours to minify by default. */
	if (st.isDirectory()) {
		if (basename(p) === 'vendor') return;
		readdirSync(p).forEach((f) => walk(join(p, f)));
	}
	else if (p.endsWith('.js')) files.push(p);
};
roots.forEach(walk);

/* A minifier handed nothing must not exit 0. The step this replaces globbed a path that matched no
 * file and said nothing, and a release shipped the sources verbatim. */
if (!files.length) {
	console.error(`minify-js: no .js files under ${roots.join(', ')} — nothing to minify, which is not a build`);
	process.exit(1);
}

/* Walk every node of an acorn AST. Hand-rolled because acorn-walk is not a dependency and this
 * is the whole of what would be used from it: recurse into anything that looks like a node. */
function walkAst(node, visit) {
	if (!node || typeof node.type !== 'string') return;
	visit(node);
	for (const k of Object.keys(node)) {
		if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
		const v = node[k];
		if (Array.isArray(v)) v.forEach((c) => walkAst(c, visit));
		else walkAst(v, visit);
	}
}

/* Every name the file BINDS, anywhere and at any depth. Deliberately scope-blind: this feeds a
 * subtraction, and over-collecting here can only shrink the reserved set's input, never invent a
 * free name that is not one. */
function boundNames(ast) {
	const out = new Set();
	const fromPattern = (p) => walkAst(p, (n) => {
		if (n.type === 'Identifier') out.add(n.name);
		/* a property KEY inside a destructuring pattern binds nothing: `{ a: b }` binds b */
		if (n.type === 'Property' && !n.computed && n.key && n.key.type === 'Identifier') out.delete(n.key.name);
	});
	walkAst(ast, (n) => {
		if (n.type === 'VariableDeclarator') fromPattern(n.id);
		else if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' ||
		         n.type === 'ArrowFunctionExpression' || n.type === 'ClassDeclaration' ||
		         n.type === 'ClassExpression') {
			if (n.id) out.add(n.id.name);
			(n.params || []).forEach(fromPattern);
		}
		else if (n.type === 'CatchClause' && n.param) fromPattern(n.param);
	});
	return out;
}

/* Names the file USES but never binds — its seam with the LuCI wrapper and with the browser.
 * These are exactly the names terser must not hand to one of its own variables. */
function freeNames(src) {
	const ast = acorn.parse(src, ACORN);
	const bound = boundNames(ast);
	const used = new Set();
	walkAst(ast, (n) => {
		if (n.type === 'MemberExpression' && !n.computed && n.property) n.property._notARef = true;
		/* `{ E }` is BOTH the key and a reference to E — a shorthand key must stay a reference */
		if (n.type === 'Property' && !n.computed && !n.shorthand && n.key) n.key._notARef = true;
		if (n.type === 'LabeledStatement' && n.label) n.label._notARef = true;
		if (n.type === 'BreakStatement' && n.label) n.label._notARef = true;
		if (n.type === 'ContinueStatement' && n.label) n.label._notARef = true;
		if (n.type === 'Identifier' && !n._notARef) used.add(n.name);
	});
	return new Set([ ...used ].filter((n) => !bound.has(n)));
}

/* The wrapper's parameters, which are bound whether the file mentions them or not — the half a
 * "free variables of the source" answer gets wrong. luci.js evaluates a resource file as
 * `function(window, document, L, <one arg per require pragma>) { … }`, so those names are already
 * declared in the scope terser minifies into: a file that never reads `L` outside a comment is not
 * free of it by any AST measure, and terser handing `L` to a top-level `const` is a redeclaration
 * of the parameter and a SyntaxError before a line of it runs.
 *
 * The alias is derived exactly the way luci.js derives it, so this list cannot drift. `E` and `_`
 * are not parameters — luci.js puts them on `window` — and are reserved anyway: the difference
 * between "harmless shadowing" and "the element factory is gone" is whether some later line reads
 * one from a place the AST cannot see, and this page builds every row with E(). */
function wrapperParams(src) {
	const names = new Set([ 'window', 'document', 'L', 'E', '_' ]);
	for (const d of directives(src).split('\n')) {
		const m = /^require[ \t]+(\S+)(?:[ \t]+as[ \t]+([a-zA-Z_]\S*))?$/.exec(d);
		if (m) names.add(m[2] || m[1].replace(/[^a-zA-Z0-9_]/g, '_'));
	}
	return names;
}

/* the leading run of string-literal ExpressionStatements: 'use strict' + the require pragmas */
function directives(src) {
	const body = acorn.parse(src, ACORN).body;
	const out = [];
	for (const n of body) {
		if (n.type !== 'ExpressionStatement' || n.expression.type !== 'Literal' ||
		    typeof n.expression.value !== 'string')
			break;
		out.push(n.expression.value);
	}
	return out.join('\n');
}

let before = 0, after = 0, failed = 0;
for (const f of files) {
	const name = basename(f);
	const src = readFileSync(f, 'utf8');
	/* the two halves of "names this scope already has": what the file reads without binding, and
	 * what the LuCI wrapper binds for it whether it reads them or not */
	const free = new Set([ ...freeNames(src), ...wrapperParams(src) ]);
	const res = await minify(src, {
		parse: { bare_returns: true },
		/* directives:false = do NOT remove them — the pragmas ARE directives */
		compress: { directives: false, toplevel: true, passes: 3 },
		mangle: { toplevel: true, reserved: [ ...free ] },
	});
	const min = res.code;
	try {
		acorn.parse(min, ACORN);
		/* a lost require pragma raises nothing at minify time: the module would simply load with no
		 * dependencies, on the router, for good */
		if (directives(min) !== directives(src))
			throw new Error('directive prologue changed — a require pragma was lost');
		/* The one that matters most: a name the source only USES must not come back DECLARED.
		 * `const L = …` in the output shadows the wrapper's parameter and the module dies at parse
		 * time with "Identifier 'L' has already been declared". */
		const clash = [ ...boundNames(acorn.parse(min, ACORN)) ].filter((n) => free.has(n));
		if (clash.length)
			throw new Error(`the minifier declared ${clash.join(', ')} — a name this file gets from the LuCI wrapper`);
		/* a floor, not a budget: an empty or truncated write must not ship */
		if (!min || min.length < 100 || min.length >= src.length)
			throw new Error(`implausible output size ${min && min.length} (source ${src.length})`);
	} catch (e) {
		console.log(`  FAIL ${name}: ${e.message}`);
		failed++;
		continue;
	}
	writeFileSync(f, min);
	before += src.length; after += min.length;
	console.log(`  ${String(src.length).padStart(7)} -> ${String(min.length).padStart(6)}  ${name}`);
}

console.log(`minify-js: ${before} -> ${after} bytes (${before ? Math.round(100 - after * 100 / before) : 0}% smaller), ${files.length} files`);
if (failed) {
	console.error(`minify-js: ${failed} file(s) failed verification — refusing to ship`);
	process.exit(1);
}
