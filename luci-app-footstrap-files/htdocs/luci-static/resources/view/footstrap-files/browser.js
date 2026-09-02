'use strict';
'require view';
'require dom';
'require fs';
'require ui';
'require request';
'require rpc';
'require view.footstrap-files.editor as editor';

/* A file manager for the router, written as ordinary LuCI markup.
 *
 * THE TABLE IS A LuCI TABLE — `.table`/`.tr`/`.th`/`.td` with `data-title` on every cell — and not
 * a grid of this app's own. That is what makes it card up on a phone under the Footstrap theme,
 * inherit any other theme's table styling, and stay inside the page's own column: an app that
 * builds its own scroller gets a table the theme must then leave alone (footstrap
 * docs/third-party-apps.md rule 9), which is exactly the layout the stock file manager ends up with.
 *
 * Everything here goes through luci-base's `fs` API, which is the same ubus `file` object the stock
 * app uses and carries the fields a listing needs — name, type, size, mode, mtime, user, group. The
 * three operations ubus has no method for (mkdir, move, chmod) are `fs.exec` with an ARGUMENT ARRAY,
 * never a shell string: a file called `; reboot;` is then an argument and not a command. */

const isDir = (e) => e.type === 'directory' || (e.type === 'symlink' && e.target && e.target.type === 'directory');

/* `/a/b` + `c` -> `/a/b/c`, and no `//` however the two halves end. */
function join(dir, name) {
	return (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name;
}

function parent(path) {
	const at = path.replace(/\/+$/, '').lastIndexOf('/');
	return at <= 0 ? '/' : path.slice(0, at);
}

/* Bytes as the reader thinks of them. Directories have a size too and it means nothing to anyone,
 * so they get a dash instead. */
function fmtSize(entry) {
	if (isDir(entry)) return '-';
	const n = entry.size || 0;
	if (n < 1024) return '%d B'.format(n);
	const units = [ 'KB', 'MB', 'GB', 'TB' ];
	let v = n / 1024, i = 0;
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
	return '%.1f %s'.format(v, units[i]);
}

/* `drwxr-xr-x`, the way `ls -l` writes it: ubus hands the mode over as a number, and the octal on
 * its own ("493") is unreadable. The type letter comes from the entry rather than from the mode
 * bits, because `list` already answers that question and a symlink is worth seeing. */
const TYPE_LETTER = { directory: 'd', symlink: 'l', block: 'b', char: 'c', fifo: 'p', socket: 's', file: '-' };

function fmtMode(entry) {
	const m = entry.mode;
	if (typeof m !== 'number') return '';
	let out = TYPE_LETTER[entry.type] ?? '-';
	for (let shift = 6; shift >= 0; shift -= 3) {
		const bits = (m >> shift) & 7;
		out += (bits & 4) ? 'r' : '-';
		out += (bits & 2) ? 'w' : '-';
		out += (bits & 1) ? 'x' : '-';
	}
	return out;
}

/* The router's clock is the one the file was written by, so the time is shown in the browser's
 * locale but with no timezone conversion claimed beyond what the epoch already carries. */
function fmtTime(entry) {
	if (!entry.mtime) return '';
	const d = new Date(entry.mtime * 1000);
	return '%04d-%02d-%02d %02d:%02d'.format(
		d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes());
}

/* Directories first, then the chosen column; name always breaks the tie so the order is total and a
 * re-render cannot shuffle equal rows. */
function sortEntries(entries, key, dir) {
	const sign = dir === 'desc' ? -1 : 1;
	return entries.slice().sort((a, b) => {
		if (isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1;
		let d = 0;
		switch (key) {
		case 'size': d = (a.size || 0) - (b.size || 0); break;
		case 'mtime': d = (a.mtime || 0) - (b.mtime || 0); break;
		case 'mode': d = (a.mode || 0) - (b.mode || 0); break;
		case 'type': d = String(a.type).localeCompare(String(b.type)); break;
		default: d = 0;
		}
		return (d || a.name.localeCompare(b.name)) * sign;
	});
}

/* `644`, the form chmod takes. The human-readable string beside it is what the listing shows; this
 * is what the dialog puts in the field, because typing `rw-r--r--` into chmod does not work. */
function octal(entry) {
	return (typeof entry.mode === 'number') ? (entry.mode & 0o7777).toString(8).padStart(3, '0') : '';
}

/* ICONS: TWO SHAPES AND A LABEL, drawn inline in `currentColor`.
 *
 * The lightest thing that still answers the three questions a listing has to answer — folder or
 * file, what kind of file, and is it a link. An icon font costs a webfont on router flash and a
 * flash of nothing while it loads; a sprite sheet costs a second request and gets the ink wrong in
 * dark mode. Two `<path>`s and a `<text>` cost neither: they take the page's own colour, scale to
 * any size, and add zero files to the package.
 *
 * The extension IS the icon. Windows shows a page with the type written on it for everything it has
 * no special glyph for, and that is the honest shape here too: a router holds `.conf`, `.sh`, `.ipk`
 * and a hundred one-off names, and a curated glyph set would cover four of them and mislabel the
 * rest. */

/* Ink by family, all four from the export tier so they hold on every palette and in both modes.
 * Anything not listed keeps the page's own text colour — a neutral file, which is most of them. */
const INK = {
	dir: 'var(--primary-color-medium, #0069d9)',
	link: 'var(--text-color-medium, #666)',
	code: 'var(--success-color-medium, #2e7d32)',
	archive: 'var(--warn-color-medium, #e08600)',
	image: 'var(--primary-color-low, #6ba3e8)',
};

const FAMILY = {
	sh: 'code', ash: 'code', bash: 'code', lua: 'code', js: 'code', mjs: 'code', json: 'code',
	conf: 'code', cfg: 'code', ini: 'code', yaml: 'code', yml: 'code', uci: 'code', py: 'code',
	gz: 'archive', tgz: 'archive', xz: 'archive', bz2: 'archive', zip: 'archive', tar: 'archive',
	ipk: 'archive', apk: 'archive', img: 'archive', bin: 'archive',
	png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', ico: 'image',
};

/* Up to four characters, because five stop fitting the page at 32px and every extension that
 * matters on a router is shorter: `conf`, `json`, `tar`, `sh`. A dotfile has no extension — `.gitignore`
 * is a name, not a type — and neither has a file with no dot at all. */
function extOf(name) {
	const at = name.lastIndexOf('.');
	if (at <= 0 || at === name.length - 1) return '';
	const ext = name.slice(at + 1).toLowerCase();
	return (ext.length <= 4 && /^[a-z0-9]+$/.test(ext)) ? ext : '';
}

/* SVG NEEDS ITS OWN NAMESPACE. luci-base's `E()` builds elements with `document.createElement`,
 * which produces an unknown HTML element for `<svg>`/`<path>` — it lands in the DOM, matches the
 * selector, occupies no pixels and draws nothing. Measured: the icons were in the markup and the
 * page showed none of them. Four lines of `createElementNS` are the whole fix. */
/* A file name can hold anything a filesystem allows, quotes included, and it is used as a selector
 * value when the keyboard moves focus. `CSS.escape` is on every browser this package runs on; the
 * fallback is there because a missing global would throw inside a keydown handler. */
function cssEscape(s) {
	return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

function svg(tag, attrs, kids) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
	for (const kid of (kids || [])) el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	return el;
}

/* One size per place, named rather than repeated: 22px beside a name in the list, 40px on a tile.
 * The extension label is drawn from 24px up — below that it is smaller than the smallest legible
 * text and reads as dirt on the glyph. */
const ICON_LIST = 39;
const ICON_TILE = 78;

/* ---- the toolbar's icons ----------------------------------------------------------------------
 *
 * Stroked, one weight, `currentColor`: a toolbar button changes colour with its state (the active
 * view mode is `cbi-button-action`, Delete is `cbi-button-negative`), and a filled icon in a fixed
 * ink would be invisible on the blue one. Every button keeps its wording in `title` and
 * `aria-label` — the icon is the only thing drawn, so the name has to live somewhere a screen
 * reader and a hover can reach. */
const BAR_ICON = 20;

function barIcon(d, size) {
	return svg('svg', {
		class: 'fsf-bicon', viewBox: '0 0 24 24', width: size || BAR_ICON, height: size || BAR_ICON, 'aria-hidden': 'true',
		fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
		'stroke-linecap': 'round', 'stroke-linejoin': 'round',
	}, d.map((one) => svg('path', { d: one })));
}

const BAR = {
	go: [ 'M4 12h13', 'M12 6l6 6-6 6' ],
	up: [ 'M12 20V5', 'M5 12l7-7 7 7' ],
	refresh: [ 'M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5' ],
	mkdir: [ 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M12 11v6', 'M9 14h6' ],
	touch: [ 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M12 11v6', 'M9 14h6' ],
	copy: [ 'M9 9h10v11H9z', 'M15 5H5v10' ],
	move: [ 'M12 3v18', 'M3 12h18', 'M9 6l3-3 3 3', 'M9 18l3 3 3-3', 'M6 9l-3 3 3 3', 'M18 9l3 3-3 3' ],
	remove: [ 'M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13' ],
	upload: [ 'M12 16V4', 'M7 9l5-5 5 5', 'M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' ],
	list: [ 'M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01' ],
	grid: [ 'M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z' ],
	/* select mode's own two: everything, and done */
	check: [ 'M5 13l4 4L19 7' ],
	checkAll: [ 'M3 8l2 2 4-4', 'M3 17l2 2 4-4', 'M13 9h8', 'M13 18h8' ],
	/* the row's own actions, drawn one size down (see ROW_ICON) */
	edit: [ 'M4 20h4l10-10-4-4L4 16z', 'M14 6l4 4' ],
	download: [ 'M12 4v12', 'M7 11l5 5 5-5', 'M4 20h16' ],
	info: [ 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8h.01' ],
	/* a luggage tag: renaming is giving the thing a different label, and an I-beam next to the
	 * pencil above read as a second Edit */
	rename: [ 'M12 3H5a2 2 0 0 0-2 2v7l9 9 9-9-9-9z', 'M7.5 7.5h.01' ],
	/* the editor's own: a magnifier, drawn at the toolbar's weight so it sits with Save and Close */
	find: [ 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4.35-4.35' ],
};

/* One size down from the toolbar's: a row is 39px of icon and five buttons already, and the actions
 * are the secondary reading of it. */
const ROW_ICON = 16;

const ICON = {
	dir(size) {
		return svg('svg', { class: 'fsf-icon', viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' }, [
			svg('path', { fill: INK.dir, d: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z' }),
		]);
	},

	/* A symlink is drawn as what it points AT — a link to a directory behaves like a directory — with
	 * the arrow that says it is one step removed. Getting this wrong is how a listing tells the
	 * reader to click something that is not there. */
	link(size, toDir) {
		return svg('svg', { class: 'fsf-icon', viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' }, [
			svg('path', {
				fill: INK.link,
				d: toDir
					? 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z'
					: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm0 2 4.5 4.5H14V4z',
			}),
			svg('path', { fill: 'currentColor', d: 'M8 16h5l-1.8-1.8 1.4-1.4L16.8 17l-4.2 4.2-1.4-1.4L13 18H8z' }),
		]);
	},

	/* DRAWN AS AN OUTLINE, NOT AS A WASHED-OUT FILL. The sheet used to be the family's ink at 28%
	 * opacity, which is a colour nobody chose: on the theme's own surfaces it came out as a pale
	 * smudge, and in dark mode a 28% wash of an already-light ink is barely there at all. An outline
	 * keeps the family's colour at full strength, matches the toolbar's stroked icons, and leaves the
	 * label reading against the page's own background rather than against a tint of itself.
	 *
	 * A directory stays solid on purpose: it is the thing the reader is aiming at, and the contrast
	 * between a filled folder and an outlined sheet is what makes the two scannable at 16px. */
	file(size, name) {
		const ext = extOf(name || '');
		const ink = INK[FAMILY[ext]] || 'currentColor';
		const kids = [
			svg('path', {
				fill: 'none', stroke: ink, 'stroke-width': '1.6',
				'stroke-linejoin': 'round', 'stroke-linecap': 'round',
				d: 'M14 2.8H6.5a1.7 1.7 0 0 0-1.7 1.7v15a1.7 1.7 0 0 0 1.7 1.7h11a1.7 1.7 0 0 0 1.7-1.7V8z',
			}),
			svg('path', {
				fill: 'none', stroke: ink, 'stroke-width': '1.6',
				'stroke-linejoin': 'round', 'stroke-linecap': 'round',
				d: 'M14 2.8V8h5.2',
			}),
		];
		/* The label is drawn INSIDE the sheet rather than beside it: beside it, a long name and a
		 * long extension compete for the same line and the tile grows a second row. */
		if (ext && size >= 24)
			kids.push(svg('text', {
				x: '12', y: '17.5', fill: ink, 'text-anchor': 'middle',
				'font-size': ext.length > 3 ? '5.5' : '7', 'font-weight': '700',
				'font-family': 'ui-monospace, monospace',
			}, [ ext.toUpperCase() ]));
		return svg('svg', { class: 'fsf-icon', viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' }, kids);
	},

	/* What a listing entry looks like, whatever it is. */
	for(entry, size) {
		if (entry.type === 'symlink')
			return this.link(size, !!(entry.target && entry.target.type === 'directory'));
		if (isDir(entry)) return this.dir(size);
		return this.file(size, entry.name);
	},
};

function fail(what, err) {
	ui.addNotification(null, E('p', '%s: %s'.format(what, err && err.message ? err.message : err)), 'error');
}

return view.extend({
	/* No form to save: every action here is immediate, and leaving the buttons on would offer the
	 * reader a Save that saves nothing. */
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	path: '/',
	sortKey: 'name',
	sortDir: 'asc',
	selection: null,
	/* The iOS Files model: one tap opens, and selecting several is a MODE the reader turns on. Off,
	 * every row and tile is a link; on, the same tap ticks instead and a bar at the top says how many.
	 * `anchor` is the pivot Shift extends from, `order` the paths in the order they are drawn — a
	 * range is a slice of that, so a re-sort or a refresh cannot make it mean something else. */
	selectMode: false,
	anchor: null,
	order: null,

	load() {
		/* The path lives in the URL fragment, so a browser reload, a bookmark and the back button
		 * all return to the directory the reader was in. It is read once here and written by
		 * `go()`; nothing else touches `location`. */
		/* DECODED BEFORE IT IS JUDGED: the fragment this view writes is percent-encoded, so testing
		 * the raw string for a leading slash rejects every path it produced itself and the reader
		 * always lands back at `/`. */
		let at = (location.hash || '').replace(/^#/, '');
		try { at = decodeURIComponent(at); } catch (e) { at = ''; }
		this.path = at.startsWith('/') ? at : '/';
		this.selection = new Set();
		return fs.list(this.path).catch((err) => { fail(_('Cannot read %s').format(this.path), err); return []; });
	},

	/* One redraw for everything: read the directory, then replace the table's body. `dom.content()`
	 * on the tbody rather than a full re-render of the page keeps the toolbar's focus where the
	 * reader left it. */
	refresh() {
		return fs.list(this.path).then((entries) => {
			this.entries = entries;
			/* A REFRESH KEEPS WHAT WAS TICKED. Clearing here was wrong twice over: a listing redraws
			 * after every operation, so a tick placed while one was in flight vanished with no sign
			 * — "Nothing selected" for a reason the reader could not see — and on a slower router it
			 * happened often enough to be the normal case. What is dropped instead is what is no
			 * longer there: a path deleted or moved away cannot stay selected. */
			const here = new Set(entries.map((e) => join(this.path, e.name)));
			for (const p of Array.from(this.selection)) if (!here.has(p)) this.selection.delete(p);
			this.drawListing();
			dom.content(this.crumbs, this.breadcrumbs());
			this.pathInput.value = this.path;
		}).catch((err) => fail(_('Cannot read %s').format(this.path), err));
	},

	go(path) {
		/* Selecting is about the directory the reader is in: iOS does not let a selection cross a
		 * folder boundary at all, and a set of paths that are no longer on screen is a set nobody
		 * can check before pressing Delete. */
		if (this.selectMode) { this.selectMode = false; this.selection = new Set(); this.anchor = null; }
		this.path = path || '/';
		location.hash = '#' + encodeURIComponent(this.path);
		return this.refresh();
	},

	/* THE BACK BUTTON IS A NAVIGATION TOO. The path lives in the fragment, and a fragment changes
	 * without reloading the document — so `load()` reading it once is not enough: pressing Back, or
	 * pasting a link into a tab that is already on this page, moved the address and left the listing
	 * where it was.
	 *
	 * The listener outlives this view — LuCI's router replaces `#view` and never tells a view it is
	 * gone — so it checks that the table it drew is still in the document and unhooks itself when it
	 * is not, rather than redrawing a page nobody is looking at. */
	watchHash() {
		const onHash = () => {
			if (!this.listing || !document.body.contains(this.listing)) {
				window.removeEventListener('hashchange', onHash);
				return;
			}
			let at = (location.hash || '').replace(/^#/, '');
			try { at = decodeURIComponent(at); } catch (e) { at = ''; }
			const want = at.startsWith('/') ? at : '/';
			if (want !== this.path) { this.path = want; this.refresh(); }
		};
		window.addEventListener('hashchange', onHash);
	},

	/* A REAL HREF, not `href="#"` with a click handler. Two reasons, and the first one cost an
	 * afternoon: `#` is a fragment of its own, so clicking such a link sets `location.hash` to the
	 * empty string, the hashchange listener above reads "no path" and helpfully goes to `/` — every
	 * directory link navigated to the root instead of into the directory. The second is free: a link
	 * that says where it goes can be middle-clicked into a new tab, copied, and read in the status
	 * bar, which `#` cannot. */
	href(path) {
		return '#' + encodeURIComponent(path);
	},

	breadcrumbs() {
		const out = [ E('a', { href: this.href('/') }, '/') ];
		let at = '';
		for (const part of this.path.split('/').filter(Boolean)) {
			at = join(at || '/', part);
			out.push(' ');
			out.push(E('a', { href: this.href(at) }, part));
			out.push(' / ');
		}
		return out;
	},

	/* Every cell carries `data-title`: that is the caption a themed card prints beside the value
	 * when the table stacks on a narrow screen, and without it a card is a column of unlabelled
	 * strings. */
	rows() {
		const rows = [];
		const rowBtn = (icon, label, fn, cls) => E('button', {
			class: 'btn cbi-button' + (cls ? ' ' + cls : ''), title: label, 'aria-label': label,
			click: ui.createHandlerFn(this, fn),
		}, barIcon(BAR[icon], ROW_ICON));
		if (this.path !== '/')
			rows.push(E('tr', { class: 'tr fsf-row cbi-rowstyle-1' }, [
				E('td', { class: 'td fsf-name col-10', 'data-title': _('Name') }, [
					E('span', { class: 'fsf-nameline' }, [
						ICON.dir(ICON_LIST), E('a', { href: this.href(parent(this.path)) }, '..'),
					]),
				]),
				E('td', { class: 'td', 'data-title': _('Type') }, _('Directory')),
				E('td', { class: 'td', 'data-title': _('Size') }, '-'),
				E('td', { class: 'td', 'data-title': _('Permissions') }, ''),
				E('td', { class: 'td', 'data-title': _('Modified') }, ''),
				E('td', { class: 'td', 'data-title': _('Actions') }, ''),
			]));

		this.order = [];
		for (const entry of sortEntries(this.entries || [], this.sortKey, this.sortDir)) {
			const full = join(this.path, entry.name);
			const dir = isDir(entry);
			const index = this.order.push(full) - 1;
			/* E() sets TEXT, never markup: a file called `<img onerror=…>` is a name here and
			 * nothing else. That is the whole XSS story of this page, and it is why nothing below
			 * builds HTML from a string. */
			const name = dir
				? E('a', { href: this.href(full) }, entry.name)
				: E('span', {}, entry.name);

			const row = E('tr', {
				class: 'tr fsf-row cbi-rowstyle-%d'.format(1 + (rows.length % 2)) + (this.selection.has(full) ? ' fsf-sel' : ''),
				'data-path': full, tabindex: '0',
				'aria-selected': String(this.selection.has(full)),
			}, [
				/* THE NAME IS THE FIRST CELL, and the tick sits inside it. A column of its own put an
				 * empty cell ahead of the name, and a stacked card prints cells in order — so the
				 * card opened with a blank line and its own heading came second. The checkbox is
				 * what the name is being ticked for anyway; the two belong together in both
				 * layouts. */
				/* The tick and the name are one LINE inside the cell, and the flex box is that span
				 * rather than the cell itself: `display: flex` on a `.td` takes it out of the table's
				 * own row layout, and the name then sits a few pixels above every other cell in the
				 * row — measured at 1280, the name riding over the row above it. */
				E('td', { class: 'td fsf-name col-10', 'data-title': _('Name') }, [
					E('span', { class: 'fsf-nameline' }, [
						/* The tick is drawn only while selecting. A checkbox in every row on every
						 * visit is the shape this page had, and it is the one the phone has no room
						 * for; the reader who wants several turns the mode on and gets them all. */
						this.selectMode ? E('input', {
							type: 'checkbox', 'aria-label': _('Select %s').format(entry.name),
							checked: this.selection.has(full) ? '' : null,
							click: L.bind((p, ev) => {
								ev.stopPropagation();
								this.toggle(p, ev.target.checked, index);
							}, this, full),
						}) : '',
						ICON.for(entry, ICON_LIST),
						name,
					]),
				]),
				E('td', { class: 'td', 'data-title': _('Type') }, dir ? _('Directory') : (entry.type || _('File'))),
				E('td', { class: 'td', 'data-title': _('Size') }, fmtSize(entry)),
				E('td', { class: 'td', 'data-title': _('Permissions') }, [
					E('span', { class: 'fsf-mode' }, fmtMode(entry)),
					E('span', { class: 'fsf-owner' }, ' %s:%s'.format(entry.user ?? entry.uid ?? '', entry.group ?? entry.gid ?? '')),
				]),
				E('td', { class: 'td', 'data-title': _('Modified') }, fmtTime(entry)),
				/* The same five actions as icons, named in `title` and `aria-label`: five words per
				 * row pushed the Modified column off a 1280 screen, and the row is a target now —
				 * the wording it needs is the one a hover and a screen reader read. */
				E('td', { class: 'td fsf-actions col-10', 'data-title': _('Actions') }, [
					dir ? '' : rowBtn('edit', _('Edit'), () => this.edit(full, entry), 'cbi-button-action'),
					dir ? '' : ' ',
					dir ? '' : rowBtn('download', _('Download'), () => this.download(full, entry.name)),
					' ',
					rowBtn('info', _('Properties'), () => this.properties(full, entry)),
					' ',
					rowBtn('rename', _('Rename'), () => this.rename(full, entry.name)),
					' ',
					rowBtn('remove', _('Delete'), () => this.remove([ full ]), 'cbi-button-negative'),
				]),
			]);
			/* The same actions on the right button, and — for a directory — the row itself takes a
			 * drop, so a file can be dragged onto the folder it belongs in without opening it. */
			row.addEventListener('contextmenu', (ev) => this.openMenu(ev, entry, full));
			row.addEventListener('click', (ev) => this.activate(ev, entry, full, index));
			row.addEventListener('keydown', (ev) => this.onKey(ev, entry, full, index));
			this.longPress(row, entry, full);
			if (dir) this.dropTarget(row, full);
			rows.push(row);
		}

		if (!rows.length || (rows.length === 1 && this.path !== '/'))
			rows.push(E('tr', { class: 'tr placeholder' }, E('td', { class: 'td', colspan: '6' }, E('em', {}, _('This directory is empty.')))));

		return rows;
	},

	sortBy(key) {
		this.sortDir = (this.sortKey === key && this.sortDir === 'asc') ? 'desc' : 'asc';
		this.sortKey = key;
		this.drawListing();
	},

	/* The header is rebuilt with the rows and never wrapped in anything: a `.table` lays its columns
	 * out from `.tr` SIBLINGS, so a div around the body — which is what a `<tbody>` habit produces —
	 * takes the header out of the same grid and the captions drift off the columns they name.
	 * Measured on the stand at 1280: the whole header row sat right-aligned over empty space. */
	titles() {
		const th = (key, label) => E('th', {
			class: 'th', click: key ? ui.createHandlerFn(this, () => this.sortBy(key)) : null,
			style: key ? 'cursor:pointer' : null,
		}, key && this.sortKey === key ? '%s %s'.format(label, this.sortDir === 'asc' ? '\u2191' : '\u2193') : label);

		return E('tr', { class: 'tr table-titles' }, [
			th('name', _('Name')),
			th('type', _('Type')),
			th('size', _('Size')),
			th('mode', _('Permissions')),
			th('mtime', _('Modified')),
			th(null, _('Actions')),
		]);
	},

	/* Read through cgi-io rather than ubus: `read_direct` bypasses the ubus message size limit and
	 * hands back binary intact, which a firmware image or a .tar.gz needs. The object URL is
	 * revoked on the next tick — Chrome and Firefox have both started the download by then, and a
	 * URL left behind pins the whole blob in memory for the life of the page. */
	download(path, name) {
		return fs.read_direct(path, 'blob').then((blob) => {
			const url = URL.createObjectURL(blob);
			const a = E('a', { href: url, download: name, style: 'display:none' });
			document.body.appendChild(a);
			a.click();
			window.setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
		}).catch((err) => fail(_('Cannot download %s').format(name), err));
	},

	/* EDITING IS A PANEL, NOT A DIALOG. A modal over a file listing on a phone leaves the reader
	 * typing into a box smaller than the keyboard; the panel replaces the table instead and gives
	 * the editor the whole column, with the listing one click away.
	 *
	 * The file is read through cgi-io rather than ubus: `read_direct` carries a file bigger than the
	 * ubus message limit, which /etc/config/firewall on a busy router already is. A file that is not
	 * text comes back as text anyway — so the size is checked first and anything over a megabyte is
	 * refused with a reason rather than opened as mojibake. */
	MAX_EDIT: 1024 * 1024,

	edit(path, entry) {
		if (entry && entry.size > this.MAX_EDIT)
			return fail(_('Cannot edit %s').format(entry.name),
				_('The file is %.1f MB; this editor opens files up to 1 MB.').format(entry.size / 1048576));

		return fs.read_direct(path, 'text').then((text) => {
			const box = E('div', { class: 'fsf-editor' });
			const status = E('span', { class: 'fsf-editor-status' }, '');

			/* `ui.showModal` and not a panel of this page's own: it is what LuCI opens a dialog with
			 * everywhere else, the theme already sizes and scrolls it (the overlay is the scroll
			 * container), and it is dismissed the way every other dialog on the router is. The
			 * content dies with the dialog, stylesheets included.
			 *
			 * `.fsf-modal` widens it: the stock dialog is sized for a form, and a config file read
			 * through a column that narrow is worse than no highlighting at all. */
			ui.showModal(path, [
				E('div', { class: 'fsf-modal' }, editor.styles().concat([ box ])),
				/* NOT `.cbi-page-actions`, and that is a measured decision rather than a style one. In
				 * this theme the fill for `.cbi-button-save` / `.cbi-button-reset` does come from that
				 * container — but the container is also what luci-base treats as a FORM's action bar:
				 * with it in place the page began polling `uci changes`, and this package's ACL grants
				 * `file` and `cgi-io` and no uci at all, so every tick answered
				 * `uci/get failed with error -32002: Access denied` in the console.
				 *
				 * `cbi-button-action` and `cbi-button-negative` are painted by the theme wherever they
				 * are — accent and danger — which is the blue and the red this dialog wants, with no
				 * borrowed behaviour attached.
				 *
				 * Save first, Close after it: the button the reader came for is the one their hand
				 * goes to. */
				E('div', { class: 'right fsf-modal-actions' }, [
					status,
					' ',
					/* FIND IS AN ICON AND IT IS HERE BECAUSE CTRL+F IS NOT REACHABLE ON A PHONE. The
					 * widget the editor carries is opened by Ctrl+F, F3 and Cmd+F — three gestures a
					 * touch keyboard does not have — so on a phone and on a tablet the find-and-replace
					 * this package pays 4 KB to vendor could not be opened at all. An icon rather than a
					 * word: the two buttons beside it are the ones the reader came for, and a third
					 * caption competes with them at the width where the row already wraps.
					 *
					 * Left of Save, so the destructive-to-leftmost order of the row is unchanged. */
					E('button', {
						class: 'btn cbi-button fsf-find',
						title: _('Find and replace'), 'aria-label': _('Find and replace'),
						click: ui.createHandlerFn(this, () => this.toggleFind()),
					}, barIcon(BAR.find)),
					' ',
					E('button', {
						class: 'btn cbi-button cbi-button-action',
						click: ui.createHandlerFn(this, () => this.save(path, box, status)),
					}, _('Save')),
					' ',
					E('button', {
						class: 'btn cbi-button cbi-button-negative',
						click: ui.createHandlerFn(this, () => this.closeEditor()),
					}, _('Close')),
				]),
			], 'fsf-modal-dialog');

			/* Escape closes it, the way a dialog is expected to — `ui.showModal` binds nothing of its
			 * own — and the handler is dropped again in closeEditor(), because a listener that
			 * outlives the dialog would close the NEXT one on the first Escape.
			 *
			 * WHILE THE SEARCH WIDGET IS OPEN, ESCAPE CLOSES THE WIDGET — and this handler is what
			 * does it, rather than stepping aside for the library. The library binds its own Escape
			 * to the editor's `wrapper`, and the widget is mounted as an OVERLAY beside that wrapper,
			 * so a keypress from the Find field never passes through it: measured on the 25.12 stand,
			 * the event reached window, document (capture and bubble) and the editor's root with
			 * nothing prevented, and the widget stayed open. Merely returning here — the first shape
			 * of this guard — therefore left Escape doing NOTHING at all: the widget did not close
			 * and neither did the dialog, and the reader was stuck with a widget only the mouse could
			 * dismiss.
			 *
			 * Closing the dialog on that same key is what must not happen: it would throw away an
			 * unsaved file while the reader was typing in the Find field. */
			this._escEdit = (ev) => {
				if (ev.key !== 'Escape') return;
				if (this.findOpen()) {
					/* the widget's own close() puts the caret back in the file */
					ev.preventDefault();
					ev.stopPropagation();
					return this.toggleFind();
				}
				this.closeEditor();
			};
			document.addEventListener('keydown', this._escEdit, true);

			return editor.open(box, path, typeof text === 'string' ? text : '')
				.then((ed) => { this.editing = ed; })
				.catch((err) => { this.closeEditor(); fail(_('Cannot open the editor'), err); });
		}).catch((err) => fail(_('Cannot read %s').format(path), err));
	},

	/* The widget the editor was given in editor.js. It is attached by `addExtensions`, so it exists
	 * only once the editor's promise has resolved: every caller here tolerates its absence rather
	 * than assuming the file finished loading. */
	findWidget() {
		return this.editing && this.editing.extensions && this.editing.extensions.searchWidget;
	},

	/* IS IT OPEN — asked of the DOM, because the library keeps `isOpen` to itself. `open()` puts the
	 * widget's container into the editor as an overlay and `close()` removes it, so the element
	 * being connected is the same fact under a different name. */
	findOpen() {
		const w = this.findWidget();
		return !!(w && w.element && w.element.isConnected);
	},

	/* A TOGGLE, not an open: the button stays under the reader's finger while the widget is up, and
	 * a second tap on it has to mean the obvious thing. `open(true)` selects the find field, which
	 * is what raises the keyboard on a phone — the whole reason this button exists. */
	toggleFind() {
		const w = this.findWidget();
		if (!w) return;
		if (this.findOpen()) w.close();
		else w.open(true);
	},

	closeEditor() {
		if (this._escEdit) {
			document.removeEventListener('keydown', this._escEdit, true);
			this._escEdit = null;
		}
		this.editing = null;
		ui.hideModal();
	},

	/* `fs.write` and not cgi-io: the ubus call is the one with a permission check this package's ACL
	 * actually names, and a config file is far below the message limit that made READING use cgi-io.
	 * The editor's own value is the source — never the textarea's, which is an implementation detail
	 * of the library and empty in some of its modes. */
	save(path, box, status) {
		if (!this.editing) return;
		const text = this.editing.value;
		status.textContent = _('Saving…');
		return fs.write(path, text)
			.then(() => {
				/* The dialog stays open on purpose: saving a config file is rarely the last edit, and
				 * a dialog that vanishes on Save makes the reader open it again to check. The listing
				 * behind it is re-read anyway, so the size and mtime are right when they do close. */
				status.textContent = _('Saved.');
				return this.refresh();
			})
			.catch((err) => { status.textContent = ''; fail(_('Cannot save %s').format(path), err); });
	},

	/* PROPERTIES: the mode and the owner, the two things a listing shows and could not change.
	 * ubus has no method for either, so both are `fs.exec` with an argument array — `chmod` and
	 * `chown` are the same two commands the stock app shells out to, and `--` keeps a file called
	 * `-R` an operand.
	 *
	 * Recursive is offered only for a directory, and it is not the default: `chmod -R 777 /etc` is
	 * one checkbox away from unbootable, and a file manager that makes it the easy path is a trap. */
	properties(path, entry) {
		const mode = E('input', { type: 'text', class: 'cbi-input-text', value: octal(entry), size: 6 });
		const owner = E('input', { type: 'text', class: 'cbi-input-text',
			value: '%s:%s'.format(entry.user ?? entry.uid ?? 'root', entry.group ?? entry.gid ?? 'root') });
		const recurse = E('input', { type: 'checkbox' });

		ui.showModal(_('Properties of %s').format(entry.name), [
			E('div', { class: 'cbi-value' }, [
				E('label', { class: 'cbi-value-title' }, _('Permissions (octal)')),
				E('div', { class: 'cbi-value-field' }, mode),
			]),
			E('div', { class: 'cbi-value' }, [
				E('label', { class: 'cbi-value-title' }, _('Owner (user:group)')),
				E('div', { class: 'cbi-value-field' }, owner),
			]),
			isDir(entry) ? E('div', { class: 'cbi-value' }, [
				E('label', { class: 'cbi-value-title' }, _('Apply to everything inside')),
				E('div', { class: 'cbi-value-field' }, recurse),
			]) : '',
			E('div', { class: 'right' }, [
				E('button', { class: 'btn cbi-button', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					class: 'btn cbi-button cbi-button-positive',
					click: ui.createHandlerFn(this, () => {
						ui.hideModal();
						return this.applyProperties(path, entry, mode.value.trim(), owner.value.trim(), recurse.checked);
					}),
				}, _('Apply')),
			]),
		]);
	},

	applyProperties(path, entry, mode, owner, recurse) {
		const jobs = [];
		/* Refused here rather than by chmod: a mode this does not recognise is a typo, and chmod
		 * would take `0` or `u+x` and do something the reader did not mean. */
		if (mode && !/^[0-7]{3,4}$/.test(mode))
			return fail(_('Cannot change permissions'), _('Permissions must be three or four octal digits, e.g. 644.'));
		if (mode && mode !== octal(entry))
			jobs.push([ '/bin/chmod', recurse ? [ '-R', '--', mode, path ] : [ '--', mode, path ] ]);
		const was = '%s:%s'.format(entry.user ?? entry.uid ?? '', entry.group ?? entry.gid ?? '');
		if (owner && owner !== was)
			jobs.push([ '/bin/chown', recurse ? [ '-R', '--', owner, path ] : [ '--', owner, path ] ]);
		if (!jobs.length) return;

		return jobs.reduce((chain, [ cmd, args ]) => chain.then((ok) => ok === false ? false : fs.exec(cmd, args)
			.then((r) => (r.code === 0) || (fail(_('Cannot change %s').format(entry.name), r.stderr || 'exit %d'.format(r.code)), false))
			.catch((err) => (fail(_('Cannot change %s').format(entry.name), err), false))), Promise.resolve(true))
			.then(() => this.refresh());
	},

	/* COPY AND MOVE, as a clipboard rather than as a per-row action: the destination of a copy is
	 * another directory, and a button in a row cannot ask for one. Mark here, walk there, paste. */
	clip(op) {
		const paths = Array.from(this.selection);
		/* NOT `_('… to %s first').format(op)`: the operation's name would be interpolated in English
		 * into a translated sentence, which reads as broken in every language but this one. */
		if (!paths.length) return fail(_('Nothing selected'), _('Tick the files you want first.'));
		this.clipboard = { op, paths };
		this.showClipboard();
		/* AN ACTION ENDS THE MODE, the way it does in the Files app: what was ticked is now on the
		 * clipboard, the toolbar the reader needs next is the one with Up and the paste note, and a
		 * selection left ticked in a directory they are about to leave is a set nobody can check. */
		if (this.selectMode) this.exitSelect();
	},

	showClipboard() {
		if (!this.clipNote) return;
		const c = this.clipboard;
		dom.content(this.clipNote, c ? [
			E('span', {}, (c.op === 'copy' ? _('%d item(s) to copy') : _('%d item(s) to move')).format(c.paths.length)),
			' ',
			E('button', { class: 'btn cbi-button cbi-button-action', click: ui.createHandlerFn(this, () => this.paste()) }, _('Paste here')),
			' ',
			E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, () => { this.clipboard = null; this.showClipboard(); }) }, _('Forget')),
		] : []);
	},

	/* `cp -a` rather than `cp -r`: a router's files carry modes and symlinks that a plain copy
	 * flattens, and `-a` is what preserves both. `-n` on both: a paste never overwrites silently,
	 * and the reader is told which names were already there. */
	paste() {
		const c = this.clipboard;
		if (!c) return;
		const dest = this.path;
		const cmd = c.op === 'copy' ? '/bin/cp' : '/bin/mv';
		const flags = c.op === 'copy' ? [ '-a', '-n' ] : [ '-n' ];
		return c.paths.reduce((chain, p) => chain.then(() => {
			const name = p.split('/').pop();
			const target = join(dest, name);
			if (p === target)
				return fail(_('Cannot paste'), _('Source and destination are the same directory.'));
			/* ASKED BEFORE, not only guarded by `-n`. Both `cp -n` and `mv -n` SKIP an existing
			 * destination and exit 0, so the reader who is not told sees a paste that reported
			 * nothing and did nothing — measured: a file moved onto its own name stayed where it
			 * was, with no message anywhere. `-n` stays on the command as the second line: between
			 * this check and the copy, something else may create the name. */
			return fs.stat(target).then(() => true, () => false).then((exists) => {
				if (exists)
					return fail(_('%s was not pasted').format(name),
						_('Something with that name is already here, and nothing is overwritten.'));
				return fs.exec(cmd, flags.concat([ '--', p, dest + '/' ]))
					.then((r) => { if (r.code !== 0) fail(_('Cannot paste %s').format(p), r.stderr || 'exit %d'.format(r.code)); })
					.catch((err) => fail(_('Cannot paste %s').format(p), err));
			});
		}), Promise.resolve()).then(() => {
			if (c.op === 'move') this.clipboard = null;
			this.showClipboard();
			return this.refresh();
		});
	},

	rename(path, name) {
		const to = prompt(_('Rename "%s" to:').format(name), name);
		if (to === null || to === '' || to === name) return;
		if (to.includes('/')) return fail(_('Cannot rename %s').format(name), _('A name may not contain a slash.'));
		/* ARGUMENT ARRAY, and `--` before the operands: a file named `-f` is then a file and not a
		 * flag to mv. */
		return fs.exec('/bin/mv', [ '-n', '--', path, join(this.path, to) ])
			.then((r) => (r.code === 0) ? this.refresh() : fail(_('Cannot rename %s').format(name), r.stderr || ('exit %d'.format(r.code))))
			.catch((err) => fail(_('Cannot rename %s').format(name), err));
	},

	remove(paths) {
		if (!paths.length) return;
		if (!confirm(_('Delete %d item(s)? This cannot be undone.').format(paths.length))) return;
		/* `fs.remove` is the ubus call and takes one path at a time; a directory with contents is
		 * refused by it, which is the right default for a page that deletes as root. Recursive
		 * deletion is deliberately absent from this version. */
		return Promise.all(paths.map((p) => fs.remove(p).catch((err) => ({ p, err }))))
			.then((results) => {
				const bad = results.filter((r) => r && r.err);
				/* ubus `file remove` refuses a directory with anything in it, which is the right
				 * default for a page that deletes as root. Rather than leave the reader with an
				 * error they cannot act on, the refusal is turned into the question it really is —
				 * and `rm -r` runs only after a second confirmation that names the directory. */
				const chain = bad.reduce((c, b) => c.then(() => {
					if (!confirm(_('%s could not be removed (%s). Delete it and everything inside?')
						.format(b.p, b.err && b.err.message ? b.err.message : b.err)))
						return;
					return fs.exec('/bin/rm', [ '-r', '--', b.p ])
						.then((r) => { if (r.code !== 0) fail(_('Cannot delete %s').format(b.p), r.stderr || 'exit %d'.format(r.code)); })
						.catch((err) => fail(_('Cannot delete %s').format(b.p), err));
				}), Promise.resolve());
				return chain.then(() => { if (this.selectMode) this.exitSelect(); return this.refresh(); });
			});
	},

	mkdir() {
		const name = prompt(_('New directory name:'), '');
		if (!name || name.includes('/')) return;
		return fs.exec('/bin/mkdir', [ '--', join(this.path, name) ])
			.then((r) => (r.code === 0) ? this.refresh() : fail(_('Cannot create directory'), r.stderr || ('exit %d'.format(r.code))))
			.catch((err) => fail(_('Cannot create directory'), err));
	},

	touch() {
		const name = prompt(_('New file name:'), '');
		if (!name || name.includes('/')) return;
		return fs.write(join(this.path, name), '')
			.then(() => this.refresh())
			.catch((err) => fail(_('Cannot create file'), err));
	},

	/* Upload goes through cgi-io, the same endpoint luci-base's own file browser posts to: the ubus
	 * transport cannot carry a large body, and this one streams. The session id is a form field
	 * because cgi-io authenticates the POST itself rather than through the rpc session header.
	 *
	 * ONE FILE AT A TIME, in sequence. A router serves this page off the same CPU that routes
	 * packets, and four parallel multipart POSTs of a firmware image each is how a 128 MB box starts
	 * dropping the connection the upload is running over. */
	uploadFiles(files, dest) {
		const list = Array.from(files || []);
		if (!list.length) return Promise.resolve();
		const where = dest || this.path;
		let done = 0;
		this.busy(_('Uploading %d file(s)…').format(list.length));
		return list.reduce((chain, file) => chain.then(() => {
			const data = new FormData();
			data.append('sessionid', rpc.getSessionID());
			data.append('filename', join(where, file.name));
			data.append('filedata', file);
			return request.post(L.env.cgi_base + '/cgi-upload', data).then((res) => {
				const reply = res.json();
				if (L.isObject(reply) && reply.failure)
					return fail(_('Cannot upload %s').format(file.name), reply.failure);
				done++;
				this.busy(_('Uploaded %d of %d…').format(done, list.length));
			}).catch((err) => fail(_('Cannot upload %s').format(file.name), err));
		}), Promise.resolve()).then(() => { this.busy(''); return this.refresh(); });
	},

	upload(ev) {
		const input = ev.target;
		return this.uploadFiles(input.files).then(() => { input.value = ''; });
	},

	/* One line that says what the page is doing, in the toolbar where the reader already is. Not a
	 * notification: an upload of six files would print six of them and push the listing off screen. */
	busy(text) {
		if (this.status) this.status.textContent = text || '';
	},

	/* ---- drag and drop ----------------------------------------------------------------------
	 *
	 * Dropping onto a DIRECTORY row uploads into that directory; dropping anywhere else on the
	 * listing uploads into the directory being shown. `dragover` must preventDefault or the browser
	 * opens the file instead, and `dropEffect` is what makes the cursor say "copy" rather than the
	 * ambiguous arrow.
	 *
	 * `dragenter`/`dragleave` are counted rather than paired: they fire for every child the pointer
	 * crosses, so a naive pair leaves the highlight on after the pointer has left a row with cells
	 * in it. */
	dropTarget(el, dest) {
		/* The listing's own drop target is wired ONCE and must follow the reader into the next
		 * directory, so the destination may be a function read at drop time. Wiring it per redraw
		 * instead stacked a listener per navigation. */
		const to = () => (typeof dest === 'function' ? dest() : dest);
		let depth = 0;
		const lift = () => { if (depth === 0) el.classList.remove('fsf-drop'); };
		el.addEventListener('dragenter', (ev) => {
			if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') < 0) return;
			ev.preventDefault(); depth++; el.classList.add('fsf-drop');
		});
		el.addEventListener('dragover', (ev) => {
			if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') < 0) return;
			ev.preventDefault();
			ev.dataTransfer.dropEffect = 'copy';
		});
		el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); lift(); });
		el.addEventListener('drop', (ev) => {
			if (!ev.dataTransfer || !ev.dataTransfer.files || !ev.dataTransfer.files.length) return;
			ev.preventDefault();
			ev.stopPropagation();				/* a row's drop is not also the listing's drop */
			depth = 0; lift();
			this.uploadFiles(ev.dataTransfer.files, to());
		});
	},

	/* ---- the context menu ---------------------------------------------------------------------
	 *
	 * The same actions the row already carries, on the button most people reach for. It lives INSIDE
	 * the view's tree — a menu appended to `document.body` survives the view swap and reappears on
	 * whatever page the reader opens next — and it is positioned from the pointer, clamped to the
	 * window so a right-click near the bottom edge does not open a menu below the fold.
	 *
	 * Only rows and tiles take the button. Everywhere else on the page the browser's own menu opens,
	 * because a file manager that eats "Reload" and "Inspect" everywhere is worse than one without a
	 * menu of its own. */
	menuFor(entry, full) {
		const item = (label, fn, cls) => E('button', {
			class: 'fsf-menu-item' + (cls ? ' ' + cls : ''),
			click: ui.createHandlerFn(this, () => { this.closeMenu(); return fn(); }),
		}, label);

		const dir = isDir(entry);
		/* A menu opened on something that is already ticked acts on the WHOLE selection — Explorer's
		 * and Finder's rule, and the one a reader who just ticked six files expects. On anything
		 * else it acts on that one entry, and `openMenu` has already made it the selection. */
		const many = this.selection.has(full) && this.selection.size > 1;
		const targets = many ? Array.from(this.selection) : [ full ];

		if (many) return [
			E('div', { class: 'fsf-menu-head' }, _('%d selected').format(this.selection.size)),
			item(_('Copy'), () => this.clip('copy')),
			item(_('Move'), () => this.clip('move')),
			E('div', { class: 'fsf-menu-sep' }),
			item(_('Delete'), () => this.remove(targets), 'fsf-menu-danger'),
		];

		return [
			dir ? item(_('Open'), () => this.go(full)) : item(_('Edit'), () => this.edit(full, entry)),
			dir ? '' : item(_('Download'), () => this.download(full, entry.name)),
			item(_('Rename'), () => this.rename(full, entry.name)),
			item(_('Properties'), () => this.properties(full, entry)),
			E('div', { class: 'fsf-menu-sep' }),
			/* The way into selecting several, and on a phone the ONLY way: there is no Ctrl there,
			 * and a tap opens. */
			item(_('Select'), () => this.enterSelect(full)),
			item(_('Select all'), () => this.selectAll()),
			E('div', { class: 'fsf-menu-sep' }),
			item(_('Copy'), () => { this.select(full, true); return this.clip('copy'); }),
			item(_('Move'), () => { this.select(full, true); return this.clip('move'); }),
			E('div', { class: 'fsf-menu-sep' }),
			item(_('Delete'), () => this.remove([ full ]), 'fsf-menu-danger'),
		].filter(Boolean);
	},

	/* The menu for the directory itself, on the listing's empty space: what a reader reaches for
	 * when nothing is under the finger — make something here, paste what was marked elsewhere. */
	menuForHere() {
		const item = (label, fn) => E('button', {
			class: 'fsf-menu-item',
			click: ui.createHandlerFn(this, () => { this.closeMenu(); return fn(); }),
		}, label);
		return [
			item(_('New folder'), () => this.mkdir()),
			item(_('New file'), () => this.touch()),
			this.clipboard ? item(_('Paste here'), () => this.paste()) : '',
			E('div', { class: 'fsf-menu-sep' }),
			item(_('Select all'), () => this.selectAll()),
			item(_('Refresh'), () => this.refresh()),
		].filter(Boolean);
	},

	/* THE PHONE'S RIGHT BUTTON. iOS Safari never fires `contextmenu`: a long press there raises the
	 * system callout (Copy / Look Up) and nothing else, so a touch reader had no way at all into the
	 * menu above. Held for 500 ms without moving more than 10 px, the press opens the same menu at
	 * the finger.
	 *
	 * `touchstart`/`touchmove` are PASSIVE — a non-passive listener on a row would make the listing
	 * scroll late — so the press is cancelled by movement rather than by preventDefault. Only
	 * `touchend` is cancellable, and preventing it there is what stops the synthetic click that
	 * would otherwise toggle the tile's selection under the menu that just opened.
	 *
	 * The callout itself is suppressed in CSS (`-webkit-touch-callout: none`, coarse pointers only):
	 * without it the system menu opens on top of this one. */
	longPress(el, entry, full) {
		const HOLD = 500, SLOP = 10;
		let timer = null, x = 0, y = 0, at = 0, moved = false, fired = false;
		const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } at = 0; };
		const open = () => {
			fired = true;
			if (navigator.vibrate) navigator.vibrate(10);
			this.openMenu({ preventDefault: () => {}, clientX: x, clientY: y }, entry, full);
		};
		el.addEventListener('touchstart', (ev) => {
			cancel();
			if (ev.touches.length !== 1) return;
			/* The listing's own press is for its empty space; a row and a tile have theirs. */
			if (!entry && ev.target.closest && ev.target.closest('.fsf-row, .fsf-tile')) return;
			const t = ev.touches[0];
			x = t.clientX; y = t.clientY; at = Date.now(); moved = false; fired = false;
			timer = setTimeout(() => { timer = null; open(); }, HOLD);
		}, { passive: true });
		el.addEventListener('touchmove', (ev) => {
			const t = ev.touches[0];
			if (!t || Math.abs(t.clientX - x) > SLOP || Math.abs(t.clientY - y) > SLOP) { moved = true; cancel(); }
		}, { passive: true });
		el.addEventListener('touchend', (ev) => {
			/* THE TIMER IS NOT ENOUGH ON iOS. Safari suspends JS timers while a scroll — the momentum
			 * after the finger has left included — is running, so a press begun just after scrolling
			 * counts its 500 ms late or not at all, and cancelling on release then lost it: reported
			 * from a real iPhone as "the menu does not open on /etc/config", and only after
			 * scrolling. The elapsed time is read again here, so a press that was long enough opens
			 * the menu on release even though its timer never ran.
			 *
			 * `touchend` is also the only cancellable event of the three — the other two are passive
			 * so the listing scrolls at full speed — which makes it the place to swallow the click
			 * that would otherwise open the file under the menu. */
			const held = at ? Date.now() - at : 0;
			cancel();
			if (fired) { fired = false; ev.preventDefault(); return; }
			if (!moved && held >= HOLD) { ev.preventDefault(); open(); fired = false; }
		});
		el.addEventListener('touchcancel', cancel);
	},

	openMenu(ev, entry, full) {
		ev.preventDefault();
		this.closeMenu();
		/* Right-clicking something outside the selection makes it the selection first, which is what
		 * both desktops do and what stops a menu from acting on files the reader cannot see ticked.
		 * A menu on the listing's own background (no entry) leaves the selection alone. */
		if (entry && this.selectMode && !this.selection.has(full)) {
			this.selection = new Set([ full ]);
			this.anchor = full;
			this.paintSelection();
		}
		const menu = E('div', { class: 'fsf-menu' }, entry ? this.menuFor(entry, full) : this.menuForHere());
		this.root.appendChild(menu);
		/* Measured after insertion, because a menu's height depends on how many items an entry has:
		 * a directory has no Download and a file has no Open. */
		const r = menu.getBoundingClientRect();
		/* A CONTEXT MENU DOES NOT ALWAYS COME FROM A POINTER. The menu key and Shift+F10 raise a
		 * `contextmenu` event with no coordinates — 0/0 by convention, undefined in some engines —
		 * and arithmetic on that leaves `NaNpx`, which the browser drops: the menu then lands at
		 * whatever its static position happens to be, off the bottom of the window as often as not.
		 * Without coordinates it is anchored under the row it belongs to instead. */
		const box = (ev.target && ev.target.getBoundingClientRect) ? ev.target.getBoundingClientRect() : null;
		const px = Number.isFinite(ev.clientX) && ev.clientX ? ev.clientX : (box ? box.left + 16 : 8);
		const py = Number.isFinite(ev.clientY) && ev.clientY ? ev.clientY : (box ? box.bottom : 8);
		const x = Math.min(px, window.innerWidth - r.width - 8);
		const y = Math.min(py, window.innerHeight - r.height - 8);
		menu.style.left = Math.max(8, x) + 'px';
		menu.style.top = Math.max(8, y) + 'px';
		this.menu = menu;

		/* Closed by the next thing the reader does, whatever it is. `capture` so a click on one of
		 * the page's own buttons closes the menu before that button's handler runs. */
		/* `contains()` takes a Node, and a window event's target is not one — asking it of `window`
		 * throws inside the handler and the menu then never closes at all. */
		this._closeMenu = (e) => { if (!(e.target instanceof Node) || !menu.contains(e.target)) this.closeMenu(); };
		this._escMenu = (e) => { if (e.key === 'Escape') this.closeMenu(); };
		document.addEventListener('pointerdown', this._closeMenu, true);
		document.addEventListener('keydown', this._escMenu, true);
		window.addEventListener('resize', this._closeMenu, true);
		/* SETTLING IS NOT SCROLLING. iOS keeps emitting `scroll` for a moment after the finger has
		 * gone; closing on the first one would shut the menu the press had just opened. Only a move
		 * of more than 8px from where the menu was opened counts as the reader scrolling away. */
		const y0 = window.scrollY, x0 = window.scrollX;
		this._scrollMenu = () => {
			if (Math.abs(window.scrollY - y0) > 8 || Math.abs(window.scrollX - x0) > 8) this.closeMenu();
		};
		window.addEventListener('scroll', this._scrollMenu, true);
	},

	closeMenu() {
		if (!this.menu) return;
		this.menu.remove();
		this.menu = null;
		document.removeEventListener('pointerdown', this._closeMenu, true);
		document.removeEventListener('keydown', this._escMenu, true);
		window.removeEventListener('resize', this._closeMenu, true);
		window.removeEventListener('scroll', this._scrollMenu, true);
	},

	select(path, on) {
		if (on) this.selection.add(path); else this.selection.delete(path);
	},

	/* ---- what a click means --------------------------------------------------------------------
	 *
	 * ONE TAP OPENS. Selecting several is a mode, the way the Files app does it: turned on from the
	 * long-press menu or the toolbar, off again by Done, and while it is on the same tap ticks
	 * instead of opening. A mouse does not have to wait for the mode — Ctrl/Cmd and Shift mean what
	 * they mean in Explorer and Finder, and using either turns the mode on so the bar with the
	 * count and the actions appears.
	 *
	 * `meta` is `metaKey || (ctrlKey && !mac)`: on macOS Ctrl+click is the SYSTEM's context menu and
	 * the click may never arrive, so reading ctrlKey there would be reading a gesture that means
	 * something else.
	 *
	 * The pivot rule, which is Explorer's and which a naive implementation gets wrong: a plain click
	 * and a Ctrl+click MOVE the anchor, Shift+click does not, and every Shift+click recomputes the
	 * range from that anchor rather than extending the previous result — otherwise overshooting by
	 * one row cannot be corrected without starting over. */
	activate(ev, entry, full, index) {
		/* A button, a link's own affordances and the tick each answer for themselves. */
		if (ev.target.closest && ev.target.closest('button, input, select, textarea')) return;

		const mac = /Mac|iPad|iPhone/.test(navigator.platform || navigator.userAgent || '');
		const meta = ev.metaKey || (ev.ctrlKey && !mac);
		const range = ev.shiftKey;

		if (!this.selectMode && !meta && !range) {
			/* Opening: the name of a directory is a real link, so let the browser follow it rather
			 * than navigating twice. Everything else — the row's empty space, a tile, a file — is
			 * opened here. */
			if (ev.target.closest && ev.target.closest('a')) return;
			ev.preventDefault();
			return isDir(entry) ? this.go(full) : this.edit(full, entry);
		}

		/* From here the click is a selection, and a link inside it must not navigate. */
		ev.preventDefault();
		if (!this.selectMode) this.enterSelect();

		if (range && this.anchor != null && this.order.indexOf(this.anchor) >= 0) {
			const from = this.order.indexOf(this.anchor);
			const [ lo, hi ] = from <= index ? [ from, index ] : [ index, from ];
			/* Ctrl+Shift adds the range to what is already ticked; Shift alone replaces it. */
			if (!meta) this.selection = new Set();
			for (let i = lo; i <= hi; i++) this.selection.add(this.order[i]);
		}
		else {
			/* A plain tap in select mode toggles; so does Ctrl/Cmd+click. Both move the anchor. */
			this.select(full, !this.selection.has(full));
			this.anchor = full;
		}
		this.paintSelection();
	},

	/* Space ticks, Enter opens, Shift+arrows extend, Ctrl+A takes everything: the WAI-ARIA grid
	 * pattern's own key list. A long press has no keyboard equivalent, which is why the row keeps
	 * its buttons and the menu is not the only way to any action. */
	onKey(ev, entry, full, index) {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			return isDir(entry) ? this.go(full) : this.edit(full, entry);
		}
		if (ev.key === ' ' || ev.key === 'Spacebar') {
			ev.preventDefault();
			if (!this.selectMode) this.enterSelect();
			this.select(full, !this.selection.has(full));
			this.anchor = full;
			return this.paintSelection();
		}
		if (ev.key === 'a' && (ev.ctrlKey || ev.metaKey)) {
			ev.preventDefault();
			return this.selectAll();
		}
		if (ev.key === 'Escape' && this.selectMode) {
			ev.preventDefault();
			return this.exitSelect();
		}
		if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
			const next = index + (ev.key === 'ArrowDown' ? 1 : -1);
			if (next < 0 || next >= this.order.length) return;
			ev.preventDefault();
			if (ev.shiftKey) {
				if (!this.selectMode) this.enterSelect();
				if (this.anchor == null) this.anchor = full;
				const from = Math.max(0, this.order.indexOf(this.anchor));
				const [ lo, hi ] = from <= next ? [ from, next ] : [ next, from ];
				this.selection = new Set();
				for (let i = lo; i <= hi; i++) this.selection.add(this.order[i]);
				this.paintSelection();
			}
			const el = this.listing.querySelector('[data-path="' + cssEscape(this.order[next]) + '"]');
			if (el) el.focus();
		}
	},

	/* TICKING SOMETHING REDRAWS NOTHING. Rebuilding the listing on every toggle is what made the
	 * page jump: `dom.content()` throws the rows away and builds them again, the document loses its
	 * height for a frame, and the browser scrolls — once per file, right under the finger doing the
	 * selecting. Only the classes, the ARIA state and the tick itself change here; the bar redraws
	 * because its count did, and it keeps its height while doing so. */
	paintSelection() {
		if (!this.listing) return;
		for (const el of this.listing.querySelectorAll('[data-path]')) {
			const on = this.selection.has(el.getAttribute('data-path'));
			el.classList.toggle(el.classList.contains('fsf-tile') ? 'fsf-tile-sel' : 'fsf-sel', on);
			el.setAttribute('aria-selected', String(on));
			const box = el.querySelector('input[type="checkbox"]');
			if (box) box.checked = on;
		}
		this.drawBar();
	},

	toggle(path, on, index) {
		this.select(path, on);
		this.anchor = path;
		this.paintSelection();
	},

	selectAll() {
		if (!this.selectMode) this.enterSelect();
		for (const p of (this.order || [])) this.selection.add(p);
		this.paintSelection();
	},

	/* The mode itself. Entering it does NOT tick anything on its own — the caller says what the
	 * reader pointed at, and the long-press menu's "Select" passes the entry it was opened on. */
	enterSelect(path) {
		this.selectMode = true;
		if (path) { this.selection.add(path); this.anchor = path; }
		this.drawListing();
	},

	exitSelect() {
		this.selectMode = false;
		this.selection = new Set();
		this.anchor = null;
		this.drawListing();
	},

	/* ---- the grid ------------------------------------------------------------------------------
	 *
	 * The other way people read a directory: one tile per entry, name under an icon. Windows calls it
	 * Icons, every file manager has it, and on a phone it is the shape that fits — four tiles across
	 * where the table gives one card.
	 *
	 * Selection follows the desktop convention rather than the table's: a single click selects, a
	 * double click opens a directory or edits a file. The checkbox stays the accessible way in — it
	 * is what a keyboard and a screen reader can use, and it is what the toolbar's Copy/Move read. */
	tiles() {
		const out = [];
		this.order = [];
		if (this.path !== '/')
			out.push(E('a', { class: 'fsf-tile fsf-tile-up', href: this.href(parent(this.path)) }, [
				ICON.dir(ICON_TILE), E('span', { class: 'fsf-tile-name' }, '..'),
			]));

		for (const entry of sortEntries(this.entries || [], this.sortKey, this.sortDir)) {
			const full = join(this.path, entry.name);
			const dir = isDir(entry);
			const index = this.order.push(full) - 1;
			const tile = E('div', {
				class: 'fsf-tile' + (this.selection.has(full) ? ' fsf-tile-sel' : ''),
				tabindex: '0', role: 'option', 'data-path': full,
				'aria-selected': String(this.selection.has(full)),
				title: '%s — %s%s'.format(entry.name, fmtMode(entry), dir ? '' : ', ' + fmtSize(entry)),
				click: L.bind((ev) => this.activate(ev, entry, full, index), this),
				keydown: L.bind((ev) => this.onKey(ev, entry, full, index), this),
				contextmenu: L.bind((ev) => this.openMenu(ev, entry, full), this),
			}, [
				ICON.for(entry, ICON_TILE),
				E('span', { class: 'fsf-tile-name' }, entry.name),
				E('span', { class: 'fsf-tile-meta' }, dir ? '' : fmtSize(entry)),
			]);
			this.longPress(tile, entry, full);
			if (dir) this.dropTarget(tile, full);
			out.push(tile);
		}
		return out;
	},

	/* The listing, in whichever shape the reader last chose. Kept in localStorage rather than in
	 * uci: it is a per-browser convenience, it must survive a reload, and it is nobody else's
	 * business — a router's config is not the place for which way somebody likes their file list. */
	viewMode() {
		try { return localStorage.getItem('fsf-view') === 'grid' ? 'grid' : 'list'; }
		catch (e) { return 'list'; }
	},

	setViewMode(mode) {
		try { localStorage.setItem('fsf-view', mode); } catch (e) { /* private window: this session only */ }
		this.mode = mode;
		this.drawListing();
	},

	drawListing() {
		const grid = (this.mode || this.viewMode()) === 'grid';
		dom.content(this.listing, grid
			? E('div', { class: 'fsf-grid', role: 'listbox', 'aria-multiselectable': 'true' }, this.tiles())
			: E('table', { class: 'table', role: 'grid', 'aria-multiselectable': 'true' }, [ this.titles() ].concat(this.rows())));
		this.table = this.listing.querySelector('table.table');
		this.drawBar();
		if (this.modeButtons)
			for (const b of this.modeButtons)
				b.classList.toggle('cbi-button-action', b.getAttribute('data-mode') === (grid ? 'grid' : 'list'));
	},

	/* THE TOOLBAR IS ONE BAR, and select mode takes it over. A second bar below it was the first
	 * shape, and it moved the page: the toolbar already wraps to three rows on a phone, so a fourth
	 * row appearing the moment the reader ticked the first file pushed the listing down under the
	 * finger. Swapping the contents keeps the page still and puts Delete where the eye already is.
	 *
	 * `pathInput`, the two view buttons and the status span are the SAME nodes in both states —
	 * re-inserted, not rebuilt — so a half-typed path survives the swap. */
	barButton(icon, label, fn, cls, off) {
		return E('button', {
			class: 'btn cbi-button' + (cls ? ' ' + cls : ''), title: label, 'aria-label': label,
			disabled: off ? '' : null,
			click: ui.createHandlerFn(this, fn),
		}, barIcon(BAR[icon]));
	},

	drawBar() {
		if (!this.bar) return;
		const b = this.barButton.bind(this);

		if (this.selectMode) {
			const n = this.selection.size;
			return dom.content(this.bar, [
				E('span', { class: 'fsf-selcount' }, _('%d selected').format(n)),
				b('checkAll', _('Select all'), () => this.selectAll()),
				b('copy', _('Copy'), () => this.clip('copy'), null, !n),
				b('move', _('Move'), () => this.clip('move'), null, !n),
				b('remove', _('Delete'), () => this.remove(Array.from(this.selection)), 'cbi-button-negative', !n),
				b('check', _('Done'), () => this.exitSelect(), 'cbi-button-action'),
			]);
		}

		dom.content(this.bar, [
			this.pathInput,
			b('go', _('Go'), () => this.go(this.pathInput.value), 'cbi-button-action'),
			b('up', _('Up'), () => this.go(parent(this.path))),
			b('refresh', _('Refresh'), () => this.refresh()),
			b('mkdir', _('New folder'), () => this.mkdir()),
			b('touch', _('New file'), () => this.touch()),
			b('copy', _('Copy'), () => this.clip('copy')),
			b('move', _('Move'), () => this.clip('move')),
			b('remove', _('Delete selected'), () => this.remove(Array.from(this.selection)), 'cbi-button-negative'),
			/* `multiple`, because the drop path takes several and a reader who found the button
			 * would not expect it to be the poorer way in. The name goes on the INPUT: a <label> is
			 * not a control, and an aria-label on it is dropped by every screen reader. */
			E('label', { class: 'btn cbi-button', title: _('Upload') }, [
				barIcon(BAR.upload),
				E('input', {
					type: 'file', multiple: '', style: 'display:none', 'aria-label': _('Upload'),
					change: ui.createHandlerFn(this, this.upload),
				}),
			]),
			this.modeButtons[0],
			this.modeButtons[1],
			this.status,
			/* CSS shows this on a coarse pointer only: on a mouse the right button is the
			 * convention and needs no caption. */
			E('span', { class: 'fsf-hint' }, _('Long press a file for actions')),
		]);
	},

	render(entries) {
		this.entries = entries;

		this.pathInput = E('input', {
			type: 'text', class: 'cbi-input-text', value: this.path, 'aria-label': _('Path'),
			keydown: ui.createHandlerFn(this, (ev) => { if (ev.key === 'Enter') return this.go(ev.target.value); }),
		});
		this.crumbs = E('div', { class: 'fsf-crumbs' }, this.breadcrumbs());
		this.clipNote = E('div', { class: 'fsf-clip' });
		this.status = E('span', { class: 'fsf-status' });
		this.listing = E('div', { class: 'fsf-listing' });
		this.bar = E('div', { class: 'fsf-bar' });
		/* Wired once, on the node that outlives every redraw: the whole listing takes a drop for the
		 * directory being shown, and its empty space carries the directory's own menu. */
		this.dropTarget(this.listing, () => this.path);
		this.listing.addEventListener('contextmenu', (ev) => {
			if (ev.target.closest('.fsf-row, .fsf-tile')) return;
			this.openMenu(ev, null, null);
		});
		this.longPress(this.listing, null, null);
		this.mode = this.viewMode();

		const modeButton = (mode, label) => E('button', {
			class: 'btn cbi-button', 'data-mode': mode, title: label, 'aria-label': label,
			click: ui.createHandlerFn(this, () => this.setViewMode(mode)),
		}, barIcon(BAR[mode === 'grid' ? 'grid' : 'list']));
		this.modeButtons = [ modeButton('list', _('List')), modeButton('grid', _('Tiles')) ];
		this.watchHash();

		/* The root is kept, because the context menu is appended to it rather than to `document.body`:
		 * a node parked on the body outlives the view and turns up on the next page (the theme's app
		 * guide, §7). */
		this.root = E('div', { class: 'fsf' }, [
			/* The stylesheet is linked from INSIDE the view's tree, not injected into <head>: a
			 * sheet in the document head survives an SPA navigation and then paints somebody else's
			 * page, while everything under `#view` is thrown away with the page it belongs to. The
			 * theme's own notes on this are docs/third-party-apps.md; this package is on the right
			 * side of that rule by construction. */
			E('link', { rel: 'stylesheet', href: L.resource('view/footstrap-files/files.css') }),
			E('h2', {}, _('Files')),
			this.bar,
			this.crumbs,
			this.clipNote,
			this.listing,
		]);

		this.drawListing();
		return this.root;
	},
});
