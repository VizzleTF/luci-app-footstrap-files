/* THE MARKUP SINK IS IN luci-base, NOT HERE — so a grep of our own tree cannot find it.
 *
 * `E()` is `L.dom.create()`, which ends in `dom.append(node, children)`. Only the ARRAY branch of
 * that function builds text nodes; a bare string child is assigned to `node.innerHTML`. So
 * `E('span', {}, entry.name)` renders a file name as MARKUP, and a file called
 * `a<img src=q onerror=…>.txt` runs its own name in the admin session — proved on the stand, with
 * this package's ACL behind it.
 *
 * Every module that builds DOM therefore shadows `E` with a wrapper that wraps a primitive last
 * argument in an array. This gate holds that: a module that calls `E(` must define it, and nobody
 * may reach around the wrapper to `window.E` except the wrapper itself.
 *
 * `ui.showModal(title, …)` is the same sink one level up — it does `dom.create('h4', {}, title)` —
 * so its title must be an array literal too. */
import { readFileSync, readdirSync } from 'node:fs';
import * as acorn from 'acorn';

const VIEW = 'luci-app-footstrap-files/htdocs/luci-static/resources/view/footstrap-files';
const ACORN = { ecmaVersion: 2022, allowReturnOutsideFunction: true, locations: true };

let bad = 0;
const fail = (m) => { console.error('FAIL  ' + m); bad++; };

for (const name of readdirSync(VIEW).filter((f) => f.endsWith('.js'))) {
	const src = readFileSync(`${VIEW}/${name}`, 'utf8');
	const ast = acorn.parse(src, ACORN);

	let callsE = false, definesE = false, windowE = 0, modalTitles = [];
	const walk = (n) => {
		if (!n || typeof n.type !== 'string') return;
		if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'E') definesE = true;
		/* `window.E` is read, not necessarily called: the wrapper reaches it as
		 * `window.E.apply(null, args)`, where the call's callee is `.apply`. */
		if (n.type === 'MemberExpression' && n.object && n.object.name === 'window'
		    && n.property && n.property.name === 'E') windowE++;
		if (n.type === 'CallExpression') {
			const c = n.callee;
			if (c.type === 'Identifier' && c.name === 'E') callsE = true;
			if (c.type === 'MemberExpression' && c.property && c.property.name === 'showModal'
			    && n.arguments.length && n.arguments[0].type !== 'ArrayExpression')
				modalTitles.push(n.loc.start.line);
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
	for (const line of modalTitles)
		fail(`${name}:${line}: ui.showModal() title is not an array — it is rendered with dom.create('h4', {}, title)`);
}

if (bad) process.exit(1);
console.log('dom-sinks: every module that builds DOM owns its E(), and no modal title is a bare string');
