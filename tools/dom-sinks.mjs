/* THE MARKUP SINK IS IN luci-base, NOT HERE — so a grep of our own tree cannot find it.
 *
 * `dom.append(node, children)` is the sink itself:
 *
 *     if (Array.isArray(children)) { … node.appendChild(document.createTextNode(`${children[i]}`)); }
 *     else if (typeof(children) === 'function') { return this.append(node, children(node)); }
 *     else if (this.elem(children)) { return node.appendChild(children); }
 *     else if (children !== null && children !== undefined) { node.innerHTML = `${children}`; }
 *
 * Only the ARRAY and ELEMENT branches are safe. A bare string child is assigned to `innerHTML`, and
 * a FUNCTION is the same sink at one remove — append CALLS it and recurses on what comes back. So
 * `E('span', {}, entry.name)` renders a file name as MARKUP, and a file called
 * `a<img src=q onerror=…>.txt` runs its own name in the admin session — proved on the stand, with
 * this package's ACL behind it.
 *
 * `E()` IS ONLY ONE OF THAT FUNCTION'S CALLERS, and this gate is written around every door rather
 * than around that one:
 *
 *   E()                     `L.dom.create()`, which ends in dom.append. Each module shadows it with
 *                           a wrapper that wraps a primitive last argument in an array.
 *   dom.content()           empties the node and calls dom.append DIRECTLY — no E() involved. Each
 *                           module that needs it shadows it with `fill()`, which normalises the
 *                           children the same way.
 *   dom.create()/parse()    parse HTML by construction. Neither belongs in this tree at all.
 *   ui.showModal()          `dom.create('h4', {}, title)` and then `dom.content(dlg, children)`.
 *   ui.addNotification()    `dom.append(msg, E('h4', {}, title))` and then `dom.append(msg, children)`.
 *
 * The last two are in luci-base and call the GLOBAL E and the GLOBAL dom, so no shim of ours can
 * cover them; their arguments are checked by SHAPE instead. That check is an ALLOWLIST and not a
 * denylist: only a form this file can prove safe by looking at it — an array literal, a literal
 * null, or a call to the module's own `E()` — passes. A bare identifier used to pass here on the
 * comment "a node held in a variable", which the AST has no way to know and a string variable
 * satisfies just as well. */
import { readFileSync, readdirSync } from 'node:fs';
import * as acorn from 'acorn';

const VIEW = 'luci-app-footstrap-files/htdocs/luci-static/resources/view/footstrap-files';
const ACORN = { ecmaVersion: 2022, allowReturnOutsideFunction: true, locations: true };

let bad = 0;
const fail = (m) => { console.error('FAIL  ' + m); bad++; };

/* A MEMBER IS A MEMBER WHETHER OR NOT IT IS WRITTEN WITH A DOT. `dom['content']` and
 * `ui['showModal']` are the same two calls as `dom.content` and `ui.showModal`, and a check that
 * reads `property.name` sees neither — a Literal node has no `.name`. This returns the property's
 * name for both spellings, and null for a genuinely computed one, which the caller refuses. */
const propName = (m) => {
	if (!m || m.type !== 'MemberExpression' || !m.property) return null;
	if (!m.computed) return m.property.name ?? null;
	return (m.property.type === 'Literal') ? String(m.property.value) : null;
};

/* `dom.x`, and equally `L.dom.x` or `window.dom.x`: reaching the module through another object is
 * the obvious way around a shadowed name, so the object is matched on its last hop. */
const isDom = (o) => !!o && ((o.type === 'Identifier' && o.name === 'dom')
	|| propName(o) === 'dom');

/* THE ONLY SHAPES THIS FILE CAN PROVE SAFE for a child list luci-base will append:
 *   [ … ]     the array branch, which builds text nodes whatever the members turn out to be
 *   null      appended by nobody
 *   E(…)      this module's own shim, which returns an element
 * Everything else — an identifier, a template literal, a concatenation, some other call — is
 * rejected, because proving it would mean tracking a value across the module. */
const okShape = (a) => a.type === 'ArrayExpression'
	|| (a.type === 'Literal' && a.value === null)
	|| (a.type === 'Identifier' && a.name === 'undefined')
	|| (a.type === 'CallExpression' && a.callee.type === 'Identifier' && a.callee.name === 'E');

for (const name of readdirSync(VIEW).filter((f) => f.endsWith('.js'))) {
	const src = readFileSync(`${VIEW}/${name}`, 'utf8');
	const ast = acorn.parse(src, ACORN);

	let callsE = false, definesE = false, windowE = 0;
	let callsFill = false, definesFill = false, domAppend = 0;
	const dynamicTags = [], parsers = [], shapes = [], computedWindow = [], wideE = [], computedCall = [];

	const walk = (n) => {
		if (!n || typeof n.type !== 'string') return;
		if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'E') definesE = true;
		if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'fill') definesFill = true;

		/* `window.E` is read, not necessarily called: the wrapper reaches it as
		 * `window.E.apply(null, args)`, where the call's callee is `.apply`. A COMPUTED member is
		 * the same read written differently — `window['E']` counts, and `window[k]` cannot be
		 * followed at all, so it is refused rather than waved through. */
		if (n.type === 'MemberExpression' && n.object && n.object.name === 'window') {
			if (!n.computed) { if (n.property && n.property.name === 'E') windowE++; }
			else if (n.property.type === 'Literal') { if (n.property.value === 'E') windowE++; }
			else computedWindow.push(n.loc.start.line);
		}

		if (n.type === 'CallExpression') {
			const c = n.callee;
			if (c.type === 'Identifier' && c.name === 'E') {
				callsE = true;
				/* THE TAG IS A SINK OF ITS OWN. `dom.create` does
				 *     else if (html.charCodeAt(0) === 60) { elem = this.parse(html); }
				 * — a first argument beginning with `<` is PARSED AS HTML, whatever the wrapper does
				 * with the children. Every tag in this package is a literal; this keeps it that way,
				 * because the day one is built from a name is the day the wrapper stops being
				 * enough. */
				if (n.arguments.length && n.arguments[0].type !== 'Literal')
					dynamicTags.push(n.loc.start.line);
				/* THE SHIM WRAPS THE LAST ARGUMENT, AND dom.create READS THE THIRD. They are the
				 * same slot only while there are no more than three: `E('div', {}, kids, extra)`
				 * has the shim wrapping `extra`, which dom.create ignores, and handing `kids`
				 * through untouched — a bare string there is back on innerHTML. */
				if (n.arguments.length > 3) wideE.push(n.loc.start.line);
			}
			if (c.type === 'Identifier' && c.name === 'fill') callsFill = true;

			/* A computed call on `dom` or `ui` — `dom[k](…)` — is a sink this file cannot name.
			 * Neither object is ever indexed in this tree, so refusing is free. */
			if (c.type === 'MemberExpression' && c.computed && c.object.type === 'Identifier'
			    && (c.object.name === 'dom' || c.object.name === 'ui') && propName(c) === null)
				computedCall.push([ n.loc.start.line, c.object.name ]);

			if (c.type === 'MemberExpression' && isDom(c.object)) {
				const m = propName(c);
				/* Counted, not shaped: the one call that belongs in a module is the one inside
				 * `fill()`, which normalises its argument first. The count is what keeps a second
				 * one from appearing somewhere that does not. */
				if (m === 'content' || m === 'append') domAppend++;
				/* `create` reaches around the E() shim entirely, and `parse` IS
				 * `parseFromString(s, 'text/html')`. Neither has a use in this tree. */
				if (m === 'create' || m === 'parse') parsers.push([ n.loc.start.line, m ]);
			}

			const called = (c.type === 'MemberExpression') ? propName(c) : null;
			if (called === 'showModal' || called === 'addNotification')
				n.arguments.slice(0, 2).forEach((a, i) => {
					if (!okShape(a))
						shapes.push([ n.loc.start.line, called, i === 0 ? 'title' : 'children' ]);
				});
		}
		for (const k of Object.keys(n)) {
			if (k === 'loc' || k === 'start' || k === 'end' || k === 'type') continue;
			const v = n[k];
			if (Array.isArray(v)) v.forEach(walk); else walk(v);
		}
	};
	walk(ast);

	if (callsE && !definesE)
		fail(`${name}: calls E() without defining the wrapper — a string child would reach innerHTML`);
	if (definesE && windowE !== 1)
		fail(`${name}: ${windowE} call(s) to window.E — exactly one belongs here, inside the wrapper`);
	if (!definesE && windowE)
		fail(`${name}: reaches window.E directly, around the wrapper`);

	if (callsFill && !definesFill)
		fail(`${name}: calls fill() without defining it — the shim is what normalises the children`);
	if (definesFill && domAppend !== 1)
		fail(`${name}: ${domAppend} call(s) to dom.content/dom.append — exactly one belongs here, inside fill()`);
	if (!definesFill && domAppend)
		fail(`${name}: calls dom.content/dom.append directly; a string or a function there lands on innerHTML — go through fill()`);

	for (const line of computedWindow)
		fail(`${name}:${line}: computed access to a window property — the shims cannot be checked around it`);
	for (const [ line, obj ] of computedCall)
		fail(`${name}:${line}: ${obj}[…]() is a computed call on a sink-bearing object — name the method`);
	for (const line of wideE)
		fail(`${name}:${line}: E() called with more than three arguments — the shim wraps the last one, dom.create reads the third`);
	for (const line of dynamicTags)
		fail(`${name}:${line}: E() called with a tag that is not a literal — dom.create parses a first argument starting with '<'`);
	for (const [ line, m ] of parsers)
		fail(`${name}:${line}: dom.${m}() parses markup and skips the E() wrapper — build the node with E()`);
	for (const [ line, fn, which ] of shapes)
		fail(`${name}:${line}: ui.${fn}() ${which} is neither an array, a literal null nor an E() call — luci-base appends it with dom.append, which puts anything else on innerHTML`);
}

if (bad) process.exit(1);
console.log('dom-sinks: every door into dom.append is shimmed or shaped — E(), fill(), showModal, addNotification');
