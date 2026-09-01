'use strict';
'require baseclass';

/* The editor, assembled by hand out of prism-code-editor rather than taken from its `setups`.
 *
 * WHY NOT `setups/index.js`. It is one import and it costs the whole library: measured on the stand
 * with the search widget and the history exercised, the ready-made setup fetched 263 FILES —
 * `languages/index.js` is a barrel that imports every grammar the project ships, zig and xojo
 * included. The pieces below are the same editor with the grammars this router needs, and nothing
 * is loaded until the reader opens a file.
 *
 * WHAT THE PACKAGE VENDORS, and why each file is there:
 *   index.js + core-*.js        the editor itself
 *   prism/index.js + core-*.js  the tokenizer
 *   prism/languages/<lang>.js   ONE grammar per format this router actually has
 *   languages/<lang>.js         that grammar's indent and comment rules (2 lines each)
 *   extensions/search           find and replace, which a config file needs and a textarea has not
 *   extensions/matchBrackets    the one thing that makes a nested config readable
 *   layout.css, search.css, themes/github-*.css
 *
 * Its stylesheets go into the editor's own SHADOW ROOT, so `<head>` is untouched and the theme's
 * cascade layer order cannot be inverted from here (footstrap docs/css.md). That is the property
 * that ruled out Ace, whose sheets land first in <head> unless `useStrictCSP` is set. */

const V = L.resource('../footstrap-files/vendor/pce');

/* uci is not INI and not shell, but shell is the closest grammar that ships: quoted strings, `#`
 * comments and bare words all match. Measured on /etc/config/network with Prism's `ini`, which is
 * what the name suggests: 9 tokens in 120 lines, because INI wants `key=value` and `[section]`
 * while uci writes `config interface 'lan'`. A grammar of our own is a later change, not a reason
 * to ship the wrong one now. */
const BY_EXT = {
	json: 'json', conf: 'bash', sh: 'bash', ini: 'ini', nginx: 'nginx',
};

const BY_PATH = [
	[ /^\/etc\/config\//, 'bash' ],
	[ /^\/etc\/nginx\//, 'nginx' ],
];

function languageFor(path) {
	for (const [ re, lang ] of BY_PATH) if (re.test(path)) return lang;
	const ext = (path.split('/').pop().split('.').pop() || '').toLowerCase();
	return BY_EXT[ext] ?? 'bash';
}

/* The grammars vendored with this package. A file whose language is not among them is edited with
 * no highlighting rather than with a 404 in the console. */
const GRAMMARS = new Set([ 'bash', 'ini', 'json', 'nginx' ]);

let _loaded = null;

/* One load for the life of the page, whatever is opened afterwards. The modules are ES modules with
 * RELATIVE imports, so the browser resolves them straight from the router — no bundler runs in this
 * package's build, and none is needed. */
function loadEditor() {
	if (_loaded) return _loaded;
	_loaded = Promise.all([
		import(`${V}/index.js`),
		import(`${V}/prism/index.js`),
		import(`${V}/extensions/search/index.js`),
		import(`${V}/extensions/matchBrackets/index.js`),
	]).then(([ core, prism, search, brackets ]) => ({ core, prism, search, brackets }));
	return _loaded;
}

const _grammars = new Map();

function loadGrammar(lang) {
	if (!GRAMMARS.has(lang)) return Promise.resolve();
	if (!_grammars.has(lang))
		_grammars.set(lang, Promise.all([
			import(`${V}/prism/languages/${lang}.js`),
			import(`${V}/languages/${lang}.js`),
		]));
	return _grammars.get(lang);
}

/* The theme in use decides light or dark, and the editor is told rather than left to guess: the two
 * sheets are the library's own github-light/github-dark, chosen from the page's resolved colour
 * scheme. Read once per editor, because a reader who flips the theme gets a fresh page anyway. */
function themeHref() {
	const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
	const attr = document.documentElement.getAttribute('data-dark');
	const isDark = (attr === 'true') || (attr === null && dark);
	return `${V}/themes/github-${isDark ? 'dark' : 'light'}.css`;
}

return baseclass.extend({
	/* Everything the caller needs: give it a container and a file, get an editor back. The container
	 * keeps its own stylesheets, so nothing this returns leaks into the document. */
	open(container, path, text) {
		const lang = languageFor(path);
		return Promise.all([ loadEditor(), loadGrammar(lang) ]).then(([ mods ]) => {
			const editor = mods.core.createEditor(container, {
				language: lang,
				value: text,
				lineNumbers: true,
				tabSize: 4,
				insertSpaces: false,		/* uci and shell are tab-indented on this platform */
			});
			editor.addExtensions(mods.search.searchWidget(), mods.brackets.matchBrackets());
			return editor;
		});
	},

	/* The sheets the editor needs, as <link>s the CALLER owns: appended inside the view's tree, they
	 * die with `#view` on the next navigation. */
	styles() {
		return [
			E('link', { rel: 'stylesheet', href: `${V}/layout.css` }),
			E('link', { rel: 'stylesheet', href: `${V}/search.css` }),
			E('link', { rel: 'stylesheet', href: themeHref() }),
		];
	},

	languageFor: languageFor,
});
