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
			this.selection.clear();
			dom.content(this.table, [ this.titles() ].concat(this.rows()));
			dom.content(this.crumbs, this.breadcrumbs());
			this.pathInput.value = this.path;
		}).catch((err) => fail(_('Cannot read %s').format(this.path), err));
	},

	go(path) {
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
			if (!this.table || !document.body.contains(this.table)) {
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

	breadcrumbs() {
		const out = [ E('a', { href: '#', click: ui.createHandlerFn(this, () => this.go('/')) }, '/') ];
		let at = '';
		for (const part of this.path.split('/').filter(Boolean)) {
			at = join(at || '/', part);
			const to = at;
			out.push(' ');
			out.push(E('a', { href: '#', click: ui.createHandlerFn(this, () => this.go(to)) }, part));
			out.push(' / ');
		}
		return out;
	},

	/* Every cell carries `data-title`: that is the caption a themed card prints beside the value
	 * when the table stacks on a narrow screen, and without it a card is a column of unlabelled
	 * strings. */
	rows() {
		const rows = [];
		if (this.path !== '/')
			rows.push(E('div', { class: 'tr' }, [
				E('div', { class: 'td', 'data-title': ' ' }, ''),
				E('div', { class: 'td', 'data-title': _('Name') }, [
					E('a', { href: '#', click: ui.createHandlerFn(this, () => this.go(parent(this.path))) }, '..'),
				]),
				E('div', { class: 'td', 'data-title': _('Type') }, _('Directory')),
				E('div', { class: 'td', 'data-title': _('Size') }, '-'),
				E('div', { class: 'td', 'data-title': _('Permissions') }, ''),
				E('div', { class: 'td', 'data-title': _('Modified') }, ''),
				E('div', { class: 'td', 'data-title': _('Actions') }, ''),
			]));

		for (const entry of sortEntries(this.entries || [], this.sortKey, this.sortDir)) {
			const full = join(this.path, entry.name);
			const dir = isDir(entry);
			/* E() sets TEXT, never markup: a file called `<img onerror=…>` is a name here and
			 * nothing else. That is the whole XSS story of this page, and it is why nothing below
			 * builds HTML from a string. */
			const name = dir
				? E('a', { href: '#', click: ui.createHandlerFn(this, () => this.go(full)) }, entry.name)
				: E('span', {}, entry.name);

			rows.push(E('div', { class: 'tr' }, [
				E('div', { class: 'td', 'data-title': ' ' }, [
					E('input', {
						type: 'checkbox', 'aria-label': _('Select %s').format(entry.name),
						change: L.bind((p, ev) => {
							if (ev.target.checked) this.selection.add(p); else this.selection.delete(p);
						}, this, full),
					}),
				]),
				E('div', { class: 'td', 'data-title': _('Name') }, [ name ]),
				E('div', { class: 'td', 'data-title': _('Type') }, dir ? _('Directory') : (entry.type || _('File'))),
				E('div', { class: 'td', 'data-title': _('Size') }, fmtSize(entry)),
				E('div', { class: 'td', 'data-title': _('Permissions') }, [
					E('span', { class: 'fsf-mode' }, fmtMode(entry)),
					E('span', { class: 'fsf-owner' }, ' %s:%s'.format(entry.user ?? entry.uid ?? '', entry.group ?? entry.gid ?? '')),
				]),
				E('div', { class: 'td', 'data-title': _('Modified') }, fmtTime(entry)),
				E('div', { class: 'td fsf-actions', 'data-title': _('Actions') }, [
					dir ? '' : E('button', {
						class: 'btn cbi-button cbi-button-action', title: _('Edit'),
						click: ui.createHandlerFn(this, () => this.edit(full, entry)),
					}, _('Edit')),
					dir ? '' : ' ',
					dir ? '' : E('button', {
						class: 'btn cbi-button', title: _('Download'),
						click: ui.createHandlerFn(this, () => this.download(full, entry.name)),
					}, _('Download')),
					' ',
					E('button', {
						class: 'btn cbi-button', title: _('Properties'),
						click: ui.createHandlerFn(this, () => this.properties(full, entry)),
					}, _('Properties')),
					' ',
					E('button', {
						class: 'btn cbi-button', title: _('Rename'),
						click: ui.createHandlerFn(this, () => this.rename(full, entry.name)),
					}, _('Rename')),
					' ',
					E('button', {
						class: 'btn cbi-button cbi-button-negative', title: _('Delete'),
						click: ui.createHandlerFn(this, () => this.remove([ full ])),
					}, _('Delete')),
				]),
			]));
		}

		if (!rows.length || (rows.length === 1 && this.path !== '/'))
			rows.push(E('div', { class: 'tr placeholder' }, E('div', { class: 'td' }, E('em', {}, _('This directory is empty.')))));

		return rows;
	},

	sortBy(key) {
		this.sortDir = (this.sortKey === key && this.sortDir === 'asc') ? 'desc' : 'asc';
		this.sortKey = key;
		dom.content(this.table, [ this.titles() ].concat(this.rows()));
	},

	/* The header is rebuilt with the rows and never wrapped in anything: a `.table` lays its columns
	 * out from `.tr` SIBLINGS, so a div around the body — which is what a `<tbody>` habit produces —
	 * takes the header out of the same grid and the captions drift off the columns they name.
	 * Measured on the stand at 1280: the whole header row sat right-aligned over empty space. */
	titles() {
		const th = (key, label) => E('div', {
			class: 'th', click: key ? ui.createHandlerFn(this, () => this.sortBy(key)) : null,
			style: key ? 'cursor:pointer' : null,
		}, key && this.sortKey === key ? '%s %s'.format(label, this.sortDir === 'asc' ? '\u2191' : '\u2193') : label);

		return E('div', { class: 'tr table-titles' }, [
			th(null, ' '),
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
			const panel = E('div', { class: 'fsf-panel' }, [
				E('div', { class: 'fsf-bar' }, [
					E('strong', { class: 'fsf-editing' }, path),
					status,
					E('button', {
						class: 'btn cbi-button cbi-button-save',
						click: ui.createHandlerFn(this, () => this.save(path, box, status)),
					}, _('Save')),
					E('button', {
						class: 'btn cbi-button',
						click: ui.createHandlerFn(this, () => this.closeEditor()),
					}, _('Close')),
				]),
			].concat(editor.styles()).concat([ box ]));

			this.panel = panel;
			this.table.parentNode.insertBefore(panel, this.table);
			this.table.style.display = 'none';

			return editor.open(box, path, typeof text === 'string' ? text : '')
				.then((ed) => { this.editing = ed; })
				.catch((err) => { this.closeEditor(); fail(_('Cannot open the editor'), err); });
		}).catch((err) => fail(_('Cannot read %s').format(path), err));
	},

	closeEditor() {
		if (this.panel) this.panel.remove();
		this.panel = null;
		this.editing = null;
		if (this.table) this.table.style.display = '';
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
			.then(() => { status.textContent = _('Saved.'); return this.refresh(); })
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
			if (p === join(dest, p.split('/').pop()))
				return fail(_('Cannot paste'), _('Source and destination are the same directory.'));
			return fs.exec(cmd, flags.concat([ '--', p, dest + '/' ]))
				.then((r) => { if (r.code !== 0) fail(_('Cannot paste %s').format(p), r.stderr || 'exit %d'.format(r.code)); })
				.catch((err) => fail(_('Cannot paste %s').format(p), err));
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
				return chain.then(() => this.refresh());
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
	 * because cgi-io authenticates the POST itself rather than through the rpc session header. */
	upload(ev) {
		const input = ev.target;
		if (!input.files || !input.files.length) return;
		const file = input.files[0];
		const data = new FormData();
		data.append('sessionid', rpc.getSessionID());
		data.append('filename', join(this.path, file.name));
		data.append('filedata', file);
		return request.post(L.env.cgi_base + '/cgi-upload', data)
			.then((res) => {
				const reply = res.json();
				if (L.isObject(reply) && reply.failure)
					return fail(_('Cannot upload %s').format(file.name), reply.failure);
				input.value = '';
				return this.refresh();
			})
			.catch((err) => fail(_('Cannot upload %s').format(file.name), err));
	},

	render(entries) {
		this.entries = entries;

		this.pathInput = E('input', {
			type: 'text', class: 'cbi-input-text', value: this.path, 'aria-label': _('Path'),
			keydown: ui.createHandlerFn(this, (ev) => { if (ev.key === 'Enter') return this.go(ev.target.value); }),
		});
		this.crumbs = E('div', { class: 'fsf-crumbs' }, this.breadcrumbs());
		this.clipNote = E('div', { class: 'fsf-clip' });
		this.table = E('div', { class: 'table' }, [ this.titles() ].concat(this.rows()));
		this.watchHash();

		return E('div', { class: 'fsf' }, [
			/* The stylesheet is linked from INSIDE the view's tree, not injected into <head>: a
			 * sheet in the document head survives an SPA navigation and then paints somebody else's
			 * page, while everything under `#view` is thrown away with the page it belongs to. The
			 * theme's own notes on this are docs/third-party-apps.md; this package is on the right
			 * side of that rule by construction. */
			E('link', { rel: 'stylesheet', href: L.resource('../footstrap-files/files.css') }),
			E('h2', {}, _('Files')),
			E('div', { class: 'fsf-bar' }, [
				this.pathInput,
				E('button', { class: 'btn cbi-button cbi-button-action', click: ui.createHandlerFn(this, () => this.go(this.pathInput.value)) }, _('Go')),
				E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, () => this.go(parent(this.path))) }, _('Up')),
				E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, () => this.refresh()) }, _('Refresh')),
				E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, () => this.mkdir()) }, _('New folder')),
				E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, () => this.touch()) }, _('New file')),
				E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, () => this.clip('copy')) }, _('Copy')),
				E('button', { class: 'btn cbi-button', click: ui.createHandlerFn(this, () => this.clip('move')) }, _('Move')),
				E('button', {
					class: 'btn cbi-button cbi-button-negative',
					click: ui.createHandlerFn(this, () => this.remove(Array.from(this.selection))),
				}, _('Delete selected')),
				E('label', { class: 'btn cbi-button' }, [
					_('Upload'),
					E('input', { type: 'file', style: 'display:none', change: ui.createHandlerFn(this, this.upload) }),
				]),
			]),
			this.crumbs,
			this.clipNote,
			this.table,
		]);
	},
});
