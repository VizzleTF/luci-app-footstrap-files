/* THE GATE NEXT DOOR TO tools/dom-sinks.mjs, AND THE HALF IT CANNOT SEE.
 *
 * dom-sinks.mjs proves that every door into luci-base's `dom.append` goes through a shim — `E()` or
 * `fill()`. It says nothing about whether the shims are RIGHT, which is the same shape of hole the
 * shims exist to close: a check that reads only the call sites is happy the day the wrapper itself
 * stops wrapping.
 *
 * So this runs them. The shims are not copied here — they are LIFTED OUT OF THE SHIPPED MODULES by
 * their AST and executed against dom.append and dom.create as luci-base actually writes them
 * (modules/luci-base/htdocs/luci-static/resources/luci.js), with a file name that is markup. What
 * fails here is what would have run in an admin session with `file: {"/*": [list, read, write,
 * exec]}` behind it.
 *
 * THE luci-base HALF IS A COPY AND WILL DRIFT. It is thirty lines of branch, it has not moved in
 * years, and the alternative — fetching luci.js in CI — buys a gate that fails when GitHub is slow.
 * If append() ever grows a branch, this file is where that has to be noticed. */
import { readFileSync, readdirSync } from 'node:fs';
import * as acorn from 'acorn';

const VIEW = 'luci-app-footstrap-files/htdocs/luci-static/resources/view/footstrap-files';

/* ---- luci-base, verbatim ---------------------------------------------------------------------- */

const doc = { createTextNode: (s) => ({ nodeType: 3, text: String(s) }) };

function node(tag) {
	const n = {
		nodeType: 1, tag, kids: [], html: null, attrs: {},
		appendChild(c) { n.kids.push(c); return c; },
		removeChild(c) { n.kids.splice(n.kids.indexOf(c), 1); return c; },
		querySelectorAll: () => [],
		setAttribute(k, v) { n.attrs[k] = v; },
		get firstChild() { return n.kids[0] || null; },
		get lastChild() { return n.kids[n.kids.length - 1] || null; },
		set innerHTML(v) { n.html = String(v); },
		get innerHTML() { return n.html; },
	};
	return n;
}

const dom = {
	/* eslint-disable-next-line eqeqeq -- verbatim from luci-base, and only useful while it stays so */
	elem(e) { return (e != null && typeof (e) == 'object' && 'nodeType' in e); },
	append(n, children) {
		if (!this.elem(n)) return null;
		if (Array.isArray(children)) {
			for (let i = 0; i < children.length; i++) {
				if (this.elem(children[i])) n.appendChild(children[i]);
				else if (children[i] !== null && children[i] !== undefined)
					n.appendChild(doc.createTextNode(`${children[i]}`));
			}
			return n.lastChild;
		}
		else if (typeof (children) === 'function') return this.append(n, children(n));
		else if (this.elem(children)) return n.appendChild(children);
		else if (children !== null && children !== undefined) { n.innerHTML = `${children}`; return n.lastChild; }
		return null;
	},
	content(n, children) {
		if (!this.elem(n)) return null;
		while (n.firstChild) n.removeChild(n.firstChild);
		return this.append(n, children);
	},
	/* dom.create's own markup branch is the tag one, which dom-sinks.mjs holds to a literal; what
	 * matters here is that it ends in append() with the children untouched. */
	create(html, attr, data) {
		const elem = node(html);
		if (attr && typeof attr === 'object' && !Array.isArray(attr) && !this.elem(attr)) {
			for (const k in attr) if (attr[k] != null) elem.setAttribute(k, attr[k]);
			this.append(elem, data);
		}
		else this.append(elem, attr);
		return elem;
	},
};

/* ---- the shims, taken out of the shipped modules ----------------------------------------------- */

function shimsOf(src) {
	const ast = acorn.parse(src, { ecmaVersion: 2022, allowReturnOutsideFunction: true });
	const out = {};
	for (const n of ast.body)
		if (n.type === 'FunctionDeclaration' && (n.id.name === 'E' || n.id.name === 'fill'))
			out[n.id.name] = src.slice(n.start, n.end);
	if (!out.E) return null;
	const body = `${out.E}\n${out.fill || 'function fill() { return null; }'}\nreturn { E, fill };`;
	return new Function('window', 'dom', body)({ E: (...a) => dom.create(...a) }, dom);
}

/* ---- what a file name must never become ---------------------------------------------------------
 *
 * The name is the payload from the stand: `a<img src=q onerror=…>.txt` set window.__pwned when it
 * was listed. A PASS here means it came back as a text node; innerHTML holding anything at all is
 * the failure, whatever it holds. */
const EVIL = 'a<img src=q onerror=window.__pwned=1>.txt';

let bad = 0;
const text = (n) => n.kids.filter((k) => k.nodeType === 3).map((k) => k.text).join('');
const check = (what, ok, detail) => {
	console.log(`${ok ? 'PASS ' : 'FAIL '} ${what.padEnd(52)} ${detail}`);
	if (!ok) bad++;
};

for (const name of readdirSync(VIEW).filter((f) => f.endsWith('.js'))) {
	const shims = shimsOf(readFileSync(`${VIEW}/${name}`, 'utf8'));
	if (!shims) continue;
	const { E, fill } = shims;

	/* E(): the last argument is the child slot, in both the two- and three-argument forms. */
	{
		const el = E('span', {}, EVIL);
		check(`${name} E('span', {}, name)`, el.html === null && text(el) === EVIL, `innerHTML=${JSON.stringify(el.html)}`);
	}
	{
		const el = E('span', EVIL);
		check(`${name} E('span', name)`, el.html === null && text(el) === EVIL, `innerHTML=${JSON.stringify(el.html)}`);
	}
	{
		const el = E('span', {}, 42);
		check(`${name} E('span', {}, 42)`, el.html === null && text(el) === '42', `innerHTML=${JSON.stringify(el.html)}`);
	}
	/* The shapes the page passes every render must go through untouched. */
	{
		const kid = node('b');
		const el = E('div', { class: 'x' }, [ kid, EVIL ]);
		check(`${name} E('div', attrs, [ element, name ])`, el.html === null && el.kids.length === 2 && el.kids[0] === kid,
			`kids=${el.kids.length} class=${el.attrs.class}`);
	}
	{
		const kid = node('b');
		const el = E('div', {}, kid);
		check(`${name} E('div', {}, element)`, el.html === null && el.kids[0] === kid, `kids=${el.kids.length}`);
	}

	if (!/function fill\b/.test(readFileSync(`${VIEW}/${name}`, 'utf8'))) continue;

	/* fill(): the same for dom.content, including the FUNCTION branch — dom.append calls what it is
	 * given and recurses on the result, so a thunk returning a name is the sink at one remove. */
	{
		const n = node('div'); fill(n, EVIL);
		check(`${name} fill(node, name)`, n.html === null && text(n) === EVIL, `innerHTML=${JSON.stringify(n.html)}`);
	}
	{
		const n = node('div'); const thunk = () => EVIL; fill(n, thunk);
		check(`${name} fill(node, () => name)`, n.html === null && text(n) === String(thunk), `innerHTML=${JSON.stringify(n.html)}`);
	}
	{
		const n = node('div'); const kid = node('b'); fill(n, [ kid, EVIL ]);
		check(`${name} fill(node, [ element, name ])`, n.html === null && n.kids.length === 2 && n.kids[0] === kid, `kids=${n.kids.length}`);
	}
	{
		const n = node('div'); const kid = node('b'); fill(n, kid);
		check(`${name} fill(node, element)`, n.html === null && n.kids[0] === kid, `kids=${n.kids.length}`);
	}
	{
		const n = node('div'); n.appendChild(doc.createTextNode('old')); fill(n, null);
		check(`${name} fill(node, null) clears and appends nothing`, n.html === null && n.kids.length === 0, `kids=${n.kids.length}`);
	}
}

/* A gate that finds no shims at all passes for the wrong reason. */
if (!bad && !readdirSync(VIEW).some((f) => f.endsWith('.js') && /function E\(/.test(readFileSync(`${VIEW}/${f}`, 'utf8')))) {
	console.error('FAIL  no shim was found to run — this gate would pass on an empty tree');
	bad++;
}

if (bad) process.exit(1);
console.log('shims: E() and fill() turn a markup file name into text, and leave arrays and nodes alone');
