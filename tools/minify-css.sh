#!/bin/sh
# Minify one stylesheet in place, for the STAGED payload only.
#
#   tools/minify-css.sh dist/root/www/luci-static/resources/view/footstrap-files/files.css
#
# Why this and not luci.mk's own pass: the Makefile sets LUCI_MINIFY_CSS:=0 because csstidy predates
# `@layer`, `:has()` and `color-mix()` by fifteen years and drops what it does not understand while
# exiting 0. This sheet is 17 KB of which more than half is comment, uhttpd serves /www with no
# compression, and every reader of System → Files pays for all of it.
#
# The two passes are lifted from luci-theme-footstrap's build-css.sh — the same code, the same
# reasons, and they were debugged against real corruption there. Bump them together.
#
# It rewrites the file it is handed. Never point it at the checkout.
set -eu

[ $# -ge 1 ] || { echo "usage: $0 <file.css> ..." >&2; exit 2; }

# Strip /* … */, keep /*! … */ (a licence banner), drop indentation and blank lines.
#
# String-aware: a scanner that just hunts for the next "/*" lets `content: "/*"` open a comment and
# eat every rule up to the next "*/", with only the brace count below as a guard — and two such
# literals balance each other, so rules can vanish in silence.
strip_comments() {
	awk '
		BEGIN { inc = 0; q = "" }
		{
			line = $0; out = ""; i = 1; n = length(line)
			while (i <= n) {
				c = substr(line, i, 1)
				if (inc) {                                  # inside /* ... */
					if (c == "*" && substr(line, i + 1, 1) == "/") { inc = 0; i += 2; continue }
					i++; continue
				}
				if (q != "") {                              # inside a "..." or '"'"'...'"'"' string
					out = out c
					if (c == "\\") { out = out substr(line, i + 1, 1); i += 2; continue }
					if (c == q) q = ""
					i++; continue
				}
				if (c == "\"" || c == "'"'"'") { q = c; out = out c; i++; continue }
				if (c == "/" && substr(line, i + 1, 1) == "*") {
					# the banner: keep it, and everything after it on this line
					if (substr(line, i + 2, 1) == "!") { out = out substr(line, i); break }
					inc = 1; i += 2; continue
				}
				out = out c; i++
			}
			sub(/^[ \t]+/, "", out)
			sub(/[ \t]+$/, "", out)
			if (length(out)) print out
		}
	' "$1"
}

# Squeeze the whitespace CSS ignores — wire AND flash bytes, since uhttpd does not compress.
#
# Removed: the space after `:`, the spaces around `{ } ; , >`, the last `;` of a block, the newline
# after every declaration. Left alone, each for a reason:
#   - the single space between selectors: `.a .b` is a DESCENDANT combinator, `.a.b` is not;
#   - spaces inside calc(): required around `*`, `/` and the `-` of `calc(100% - 8px)`;
#   - `+` and `~`: `[attr~=v]` and `calc(100% - 10px)` make them ambiguous without bracket depth;
#   - anything inside a string: a quoted data-URI is full of `:`, `;` and spaces;
#   - one newline after `}`, so the shipped file stays greppable.
squeeze() {
	awk '
		BEGIN { q = ""; ban = 0; lastc = ""; buf = ""; lastreal = "" }
		{
			line = $0
			# A /*! banner is an attribution, not formatting: it survives BYTE FOR BYTE.
			if (ban) { print line; lastc = ""; lastreal = ""; if (index(line, "*/")) ban = 0; next }
			if (substr(line, 1, 3) == "/*!") {
				print line; lastc = ""; lastreal = ""
				if (!index(substr(line, 4), "*/")) ban = 1
				next
			}
			# The line BREAK we are about to swallow is whitespace, and a declaration may be
			# wrapped across it. Feed it to the whitespace-run logic below as a leading space:
			# it survives only where a space would (between two tokens) and is dropped next to
			# { } ; , : — lastc == "" means output is already at the start of a line.
			if (lastc != "" && q == "") line = " " line
			out = ""; i = 1; n = length(line)
			while (i <= n) {
				c = substr(line, i, 1)
				if (q != "") {                       # inside a string: copy verbatim
					out = out c
					if (c == "\\") { out = out substr(line, i + 1, 1); i += 2; continue }
					if (c == q) q = ""
					lastreal = ""                # a char inside a string is not structure
					i++; continue
				}
				if (c == "\"" || c == "'"'"'") { q = c; out = out c; lastreal = ""; i++; continue }
				if (c == " " || c == "\t") {         # collapse a run of whitespace to one space
					while (i <= n && (substr(line, i, 1) == " " || substr(line, i, 1) == "\t")) i++
					# the last char EMITTED, which on a continuation line lives on the
					# previous output line — hence lastc, not just `out`.
					prev = (length(out) ? substr(out, length(out), 1) : lastc)
					nxt  = (i <= n ? substr(line, i, 1) : "")
					if (prev == "" || prev == "{" || prev == "}" || prev == ";" || prev == "," || prev == ":" || prev == ">")
						continue
					if (nxt == "{" || nxt == "}" || nxt == ";" || nxt == "," || nxt == "" || nxt == ">")
						continue
					out = out " "; lastreal = " "
					continue
				}
				# THE LAST `;` OF A BLOCK IS REDUNDANT — dropped as the `}` is emitted, i.e.
				# INSIDE the string-aware scanner. A `sed "s/;}/}/g"` over the output cannot see
				# strings: `content: ";}"` comes out as `content: "}"`.
				if (c == "}") {
					if (length(out) && substr(out, length(out), 1) == ";")
						out = substr(out, 1, length(out) - 1)
					else if (!length(out) && length(buf) && substr(buf, length(buf), 1) == ";")
						buf = substr(buf, 1, length(buf) - 1)
				}
				out = out c; lastreal = c; i++
			}
			buf = buf out
			if (length(out)) lastc = substr(out, length(out), 1)
			# newline only after a closing brace — one rule per line. lastreal, not lastc: a
			# line ending in a QUOTED `}` (content: "}") is not the end of a rule.
			if (lastreal == "}") { print buf; buf = ""; lastc = ""; lastreal = "" }
		}
		END { if (length(buf)) print buf; else printf "\n" }
	' "$1"
}

# Fail loudly rather than let an unbalanced block ship. String-aware for the same reason the comment
# stripper is: a brace inside a CSS STRING is not a block.
#
# The floor is 8 rules and it is a TRUNCATION check, not a style one: the real guard is that the
# count does not change across the squeeze. It was 20 until editor.css — a sheet that paints eight
# token classes and defines a handful of variables — legitimately came in at 17 and failed the
# build.
brace_count() {
	awk -v min="${CSS_MIN_RULES:-8}" '
		BEGIN { q = "" }
		{
			line = $0; n = length(line); i = 1
			while (i <= n) {
				ch = substr(line, i, 1)
				if (q != "") {				# inside a string
					if (ch == "\\") { i += 2; continue }	# escape: skip the pair
					if (ch == q) q = ""
					i++; continue
				}
				if (ch == "\"" || ch == "'"'"'") { q = ch; i++; continue }
				if (ch == "{") o++
				else if (ch == "}") c++
				i++
			}
		}
		END {
			if (o != c) { printf "minify-css: %s: unbalanced braces (%d { vs %d })\n", FILENAME, o, c > "/dev/stderr"; exit 1 }
			if (o < min) { printf "minify-css: %s: suspiciously few rules (%d)\n", FILENAME, o > "/dev/stderr"; exit 1 }
			print o
		}
	' "$1"
}

for f in "$@"; do
	[ -f "$f" ] || { echo "minify-css: $f is not a file" >&2; exit 1; }
	tmp="$f.min"
	before=$(wc -c < "$f" | tr -d ' ')

	# Always brace-check a COMMENT-STRIPPED copy: a stray "{" in prose would otherwise fail the
	# build on perfectly valid CSS.
	strip_comments "$f" > "$tmp"
	rules_before=$(brace_count "$tmp") || { rm -f "$tmp"; exit 1; }

	squeeze "$tmp" > "$tmp.2"
	mv "$tmp.2" "$tmp"

	# AND AGAIN, on what actually ships: the check above only saw the squeeze's INPUT, yet the
	# squeeze is the pass most able to corrupt the sheet — it tracks strings, joins lines and
	# deletes the `;` before a `}`. An unchanged rule count is what says it did not.
	rules_after=$(brace_count "$tmp") || { rm -f "$tmp"; exit 1; }
	if [ "$rules_before" != "$rules_after" ]; then
		echo "minify-css: the squeeze changed the rule count ($rules_before -> $rules_after)" >&2
		rm -f "$tmp"; exit 1
	fi

	# A FLOOR, NOT A BUDGET. With only an upper bound, every way of producing a SHORT file — a
	# truncated write, a full disk, a squeeze that ate the tail — passes and ships a stylesheet with
	# its second half missing. Half the input is the comment header, so a third of it is generous.
	after=$(wc -c < "$tmp" | tr -d ' ')
	floor=$((before / 4))
	if [ "$after" -lt "$floor" ] || [ "$after" -ge "$before" ]; then
		echo "minify-css: $f would go $before -> $after bytes, which is not a smaller sheet but a" >&2
		echo "            broken one. The file is left untouched." >&2
		rm -f "$tmp"; exit 1
	fi

	mv "$tmp" "$f"
	printf '  %7d -> %6d  %s (%d rules)\n' "$before" "$after" "$(basename "$f")" "$rules_after"
done
