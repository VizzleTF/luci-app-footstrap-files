'use strict';
'require baseclass';
'require dom';

/* A hex editor, in about two hundred lines.
 *
 * WHY NOT THE STOCK ONE. luci-app-filemanager ships 40,660 bytes of HexEditor: ASCII, hex and
 * RegExp search, a settings panel for its own padding, and a `<style>` element injected into the
 * document — which outlives the page that added it and repaints the next one. Half of that is the
 * search. This is the other half: look at the bytes, change them, save them.
 *
 * VIRTUAL SCROLLING IS NOT AN OPTIMISATION HERE, it is the only way the thing works. At 16 bytes a
 * line a 1 MB file is 65,536 lines; building them costs seconds and holding them costs a phone its
 * tab. What exists instead is a spacer of the full height and a window of the lines actually on
 * screen, redrawn on scroll.
 *
 * THE FILE IS NOT A STRING. It arrives as a Blob through cgi-io (`fs.read_direct`, which is what
 * this page already uses to download) and lives as a Uint8Array; nothing here decodes it, because
 * the whole point is the bytes that are not text. The caller reads them back with `value()`. */

const ROW = 16;			/* bytes per line — the width every hex dump has had since od(1) */
const OVERSCAN = 6;		/* lines drawn above and below the window, so a fast scroll has cover */

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

/* A byte is printable if it is a printable ASCII character; everything else is a dot, the way every
 * hex dump does it. Latin-1 would be prettier and a lie: the file has no encoding. */
function ascii(b) {
	return (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.';
}

return baseclass.extend({
	/* `container` is emptied and filled. Returns a handle: `value()` for the bytes, `dirty()` for
	 * whether anything was typed. */
	open(container, bytes) {
		const data = new Uint8Array(bytes);
		const lines = Math.max(1, Math.ceil(data.length / ROW));
		let caret = 0;			/* byte the caret is on */
		let nibble = 0;			/* 0 = the high half of that byte is next, 1 = the low half */
		let touched = false;
		let first = -1;			/* first line currently drawn, so a scroll that moves nothing redraws nothing */

		const layer = E('div', { class: 'fsf-hex-layer' });
		const spacer = E('div', { class: 'fsf-hex-spacer' }, layer);
		const view = E('div', { class: 'fsf-hex', tabindex: '0' }, spacer);

		/* MEASURED, NOT ASSUMED. The line height is whatever the theme's monospace stack gives at
		 * this size, and a guess would drift a pixel per line — 65,536 lines of drift. One line is
		 * rendered off-screen to ask. */
		const probe = E('div', { class: 'fsf-hex-line' }, E('span', { class: 'fsf-hex-off' }, '00000000'));
		view.appendChild(probe);
		const LH = probe.getBoundingClientRect().height || 18;
		probe.remove();

		spacer.style.height = (lines * LH) + 'px';

		const line = (n) => {
			const start = n * ROW;
			const cells = [];
			for (let i = 0; i < ROW; i++) {
				const at = start + i;
				const has = at < data.length;
				cells.push(E('span', {
					class: 'fsf-hex-b' + (at === caret ? ' fsf-hex-at' : ''),
					'data-at': has ? String(at) : null,
				}, has ? HEX[data[at]] : '  '));
			}
			let text = '';
			for (let i = 0; i < ROW && start + i < data.length; i++) text += ascii(data[start + i]);
			return E('div', { class: 'fsf-hex-line' }, [
				E('span', { class: 'fsf-hex-off' }, (start).toString(16).padStart(8, '0')),
				E('span', { class: 'fsf-hex-bytes' }, cells),
				E('span', { class: 'fsf-hex-text' }, text),
			]);
		};

		const draw = (force) => {
			const top = Math.max(0, Math.floor(view.scrollTop / LH) - OVERSCAN);
			if (!force && top === first) return;
			first = top;
			const count = Math.ceil(view.clientHeight / LH) + OVERSCAN * 2;
			const out = [];
			for (let n = top; n < Math.min(lines, top + count); n++) out.push(line(n));
			layer.style.transform = 'translateY(' + (top * LH) + 'px)';
			dom.content(layer, out);
		};

		/* The caret is a class on one cell, so moving it redraws nothing but the two cells involved
		 * — until it leaves the window, which is the only time the lines are rebuilt. */
		const paint = (from) => {
			const old = layer.querySelector('.fsf-hex-at');
			if (old) old.classList.remove('fsf-hex-at');
			const now = layer.querySelector('[data-at="' + caret + '"]');
			if (now) { now.classList.add('fsf-hex-at'); return; }
			/* out of view: scroll it back in, which redraws */
			const target = Math.floor(caret / ROW);
			view.scrollTop = (target - Math.floor(view.clientHeight / LH / 2)) * LH;
			draw(true);
			const el = layer.querySelector('[data-at="' + caret + '"]');
			if (el) el.classList.add('fsf-hex-at');
		};

		const move = (to) => {
			caret = Math.max(0, Math.min(data.length - 1, to));
			nibble = 0;
			paint();
		};

		view.addEventListener('scroll', () => draw(false));
		view.addEventListener('click', (ev) => {
			const cell = ev.target.closest('[data-at]');
			if (cell) move(+cell.getAttribute('data-at'));
		});

		view.addEventListener('keydown', (ev) => {
			const perScreen = Math.max(1, Math.floor(view.clientHeight / LH) - 1) * ROW;
			const keys = {
				ArrowLeft: -1, ArrowRight: 1, ArrowUp: -ROW, ArrowDown: ROW,
				PageUp: -perScreen, PageDown: perScreen,
			};
			if (keys[ev.key] != null) { ev.preventDefault(); return move(caret + keys[ev.key]); }
			if (ev.key === 'Home') { ev.preventDefault(); return move(ev.ctrlKey ? 0 : caret - (caret % ROW)); }
			if (ev.key === 'End') { ev.preventDefault(); return move(ev.ctrlKey ? data.length - 1 : caret - (caret % ROW) + ROW - 1); }

			/* TYPING IS NIBBLE BY NIBBLE, which is how every hex editor takes input: the first digit
			 * replaces the high half and leaves the caret where it is, the second replaces the low
			 * half and moves on. Anything else — a modifier, a letter past f — is not ours. */
			if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
			const d = parseInt(ev.key, 16);
			if (ev.key.length !== 1 || isNaN(d)) return;
			ev.preventDefault();
			data[caret] = nibble
				? ((data[caret] & 0xf0) | d)
				: ((data[caret] & 0x0f) | (d << 4));
			touched = true;
			const cell = layer.querySelector('[data-at="' + caret + '"]');
			if (cell) {
				cell.textContent = HEX[data[caret]];
				cell.classList.add('fsf-hex-edited');
				/* the text column of that line, rebuilt for the one character that changed */
				const text = cell.closest('.fsf-hex-line').querySelector('.fsf-hex-text');
				const start = Math.floor(caret / ROW) * ROW;
				let s = '';
				for (let i = 0; i < ROW && start + i < data.length; i++) s += ascii(data[start + i]);
				text.textContent = s;
			}
			if (nibble) { nibble = 0; if (caret + 1 < data.length) move(caret + 1); }
			else nibble = 1;
		});

		dom.content(container, view);
		draw(true);
		view.focus();

		/* `dirty()` is what a "close without saving" prompt would ask; nothing else here is offered,
		 * because an accessor nobody calls is a byte on every router that ships it. */
		return {
			value: () => data,
			dirty: () => touched,
		};
	},

	/* base64 for the ubus `file write`, in chunks small enough for `String.fromCharCode` not to
	 * blow the argument list. */
	base64(bytes, from, to) {
		let s = '';
		for (let i = from; i < to; i += 4096)
			s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(to, i + 4096)));
		return btoa(s);
	},

	ROW: ROW,
});
