import js from '@eslint/js';
import globals from 'globals';
import stylistic from '@stylistic/eslint-plugin';
import { readFileSync, readdirSync } from 'node:fs';

/* ESLint for this package's browser JS. Runs in CI and locally, never on the OpenWrt buildbot: it
 * has no node and needs none — luci.mk copies htdocs/ verbatim.
 *
 * Adapted from luci-theme-footstrap's config, which is where the reasoning behind each rule lives.
 * The two packages are linted by the same rules on purpose: they are read by the same person and
 * one of them is a plugin for the other.
 *
 * THE NON-OBVIOUS BIT: `globalReturn`. A LuCI resource file is neither a script nor an ES module —
 * luci.js evaluates its body INSIDE a function wrapper, which is why every one of these files ends
 * in a bare `return view.extend({…})` and opens with `'require ui'` pragma strings. A stock parser
 * rejects a top-level `return`, so without this the whole tree fails to parse and the lint says
 * nothing at all.
 *
 * WHAT IS NOT LINTED: `vendor/`. That is prism-code-editor's own dist, shipped verbatim, and its
 * style is not ours to have an opinion about — it is also ES modules, which this config is not
 * parsing for. */
const OURS = [ 'luci-app-footstrap-files/htdocs/**/*.js' ];
const VENDOR = [ 'luci-app-footstrap-files/htdocs/**/vendor/**' ];
const VIEW = 'luci-app-footstrap-files/htdocs/luci-static/resources/view/footstrap-files';

/* `'require view.footstrap-files.grammars as grammars';` — luci.js resolves the module and passes
 * it into this file's factory as a formal PARAMETER, so the alias is a binding no parser can see.
 * Derived from the source rather than written out here, because a list that has to be edited
 * alongside the pragma is a list that will disagree with it. */
function pragmaAliases() {
	const out = {};
	for (const f of readdirSync(VIEW).filter((f) => f.endsWith('.js'))) {
		const src = readFileSync(`${VIEW}/${f}`, 'utf8');
		for (const m of src.matchAll(/^'require\s+\S+\s+as\s+(\w+)'/gm)) out[m[1]] = 'readonly';
	}
	return out;
}

export default [
	{ ignores: [ ...VENDOR, 'node_modules/**', 'dist/**' ] },

	/* eslint:recommended as the floor: ~30 free correctness rules (no-dupe-keys, no-unreachable,
	 * getter-return, no-cond-assign…), each a bug that compiles and none a style opinion. */
	{ files: OURS, ...js.configs.recommended },
	{
		files: OURS,
		plugins: { '@stylistic': stylistic },
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'script',
			parserOptions: { ecmaFeatures: { globalReturn: true } },
			globals: {
				...globals.browser,
				/* injected by luci.js into every resource file's scope, or bound by a bare
				 * `'require <mod>'` pragma */
				L: 'readonly',
				E: 'readonly',
				_: 'readonly',
				baseclass: 'readonly',
				view: 'readonly',
				ui: 'readonly',
				dom: 'readonly',
				fs: 'readonly',
				rpc: 'readonly',
				request: 'readonly',
				uci: 'readonly',
				poll: 'readonly',
				validation: 'readonly',
				...pragmaAliases(),
			},
		},
		rules: {
			/* An empty `catch {}` is the deliberate idiom here: every localStorage access is wrapped
			 * in one, because a browser in private mode THROWS on getItem and a remembered view mode
			 * that cannot be read is not an error, it is a default. Empty blocks anywhere else stay
			 * an error. */
			'no-empty': [ 'error', { allowEmptyCatch: true } ],

			/* correctness — the ones that catch real bugs */
			'no-unused-vars': [ 'error', { args: 'none', caughtErrors: 'none' } ],
			'no-undef': 'error',
			'no-implicit-globals': 'error',
			'no-shadow': 'warn',
			'no-var': 'error',
			'prefer-const': 'warn',
			eqeqeq: [ 'error', 'always', { null: 'ignore' } ],
			'no-eval': 'error',
			'no-implied-eval': 'error',
			'no-new-func': 'error',
			'no-unsafe-optional-chaining': 'error',
			'no-constant-binary-expression': 'error',
			'no-self-compare': 'error',
			'require-atomic-updates': 'warn',

			/* THE MARKUP SINKS THIS PACKAGE PROMISES NOT TO HAVE. CI greps for them too; the grep
			 * is the gate that runs on a fresh checkout, and this is the one that runs while the
			 * line is being written. A file name from the router's filesystem must never reach any
			 * of them. */
			'no-restricted-properties': [ 'error',
				{ property: 'innerHTML', message: 'a file name is data: use E() or textContent' },
				{ property: 'outerHTML', message: 'a file name is data: use E() or textContent' },
				{ property: 'insertAdjacentHTML', message: 'a file name is data: use E()' },
			],

			/* `confirm()` and `prompt()` ARE the interaction model for rename, mkdir, delete and
			 * move on this page — a modal of our own for a one-line question is a worse answer on a
			 * phone. `alert()` is not used and stays off. */
			'no-alert': 'off',
			'no-console': [ 'warn', { allow: [ 'warn', 'error' ] } ],

			/* JSMIN SAFETY — correctness, not style. The SDK path minifies these files with jsmin,
			 * whose regex-vs-division test is a one-character lookback: `n` (the last letter of
			 * `return`) and `>` (from `=>`) are not on its allow-list, `(` is. A regex literal
			 * straight after `return` or `=>` is read as a division, and if its body contains `//`
			 * jsmin swallows the rest of the file — exiting 0 while doing it (openwrt/luci#8299).
			 * tools/t0.sh is the backstop that parses the output; this stops it being written. */
			'wrap-regex': 'error',

			'@stylistic/arrow-parens': [ 'error', 'always' ],
			'@stylistic/no-mixed-operators': 'error',
		},
	},

	/* tools/ is node, not a LuCI resource file: ES modules, node globals, no wrapper. */
	{
		files: [ 'tools/**/*.mjs' ],
		...js.configs.recommended,
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'module',
			globals: { ...globals.node },
		},
		rules: {
			'no-unused-vars': [ 'error', { args: 'none', caughtErrors: 'none' } ],
			'no-empty': [ 'error', { allowEmptyCatch: true } ],
			'no-var': 'error',
			eqeqeq: [ 'error', 'always', { null: 'ignore' } ],
		},
	},
];
