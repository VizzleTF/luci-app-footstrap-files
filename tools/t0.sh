#!/bin/sh
# T0: everything that can be checked without a router.
#
#   tools/t0.sh
#
# Three gates, and the second is the one that is not obvious:
#
#   1. every module parses;
#   2. every module still parses AFTER jsmin — the minifier the OpenWrt buildbot runs. jsmin
#      decides whether a `/` starts a regex by looking at the previous non-space character, and it
#      gets `return /re/` and `=> /re/` wrong: it treats the slash as division, swallows the rest of
#      the file as a string, and EXITS 0. A grep for the pattern is a weaker check than running the
#      minifier and parsing what comes out, because it only catches the shapes someone thought of;
#   3. every shell script parses.
#
# jsmin.c comes from openwrt/luci at the commit in luci-upstream.pin, verified by sha256 before it
# is compiled and run. A local checkout is used when there is one, so the gate does not need the
# network on a developer's machine.
set -eu
cd "$(dirname "$0")/.."

PKG=luci-app-footstrap-files
# The view's own modules. NOT the vendored editor under htdocs/luci-static/footstrap-files/vendor:
# that is third-party ES-module code we ship verbatim, it is not ours to reformat, and jsmin — which
# predates ES modules — would mangle it. The buildbot leaves it alone too (LUCI_MINIFY_JS applies to
# resources/), so minifying it here would test something nobody ships.
RES="$PKG/htdocs/luci-static/resources/view/footstrap-files"
fail=0
pass=0

ok() {
	if [ "$1" = 0 ]; then printf 'PASS  %s\n' "$2"; pass=$((pass+1))
	else printf 'FAIL  %s  %s\n' "$2" "${3:-}"; fail=$((fail+1)); fi
}

command -v node >/dev/null || { echo "t0: node not found" >&2; exit 2; }

# shellcheck disable=SC1091
. "$PKG/luci-upstream.pin"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# ---- jsmin: local checkout first, pinned download second -------------------
src=''
for c in "${LUCI_SRC:-}/modules/luci-base/src/jsmin.c" ../luci/modules/luci-base/src/jsmin.c; do
	[ -f "$c" ] && { src="$c"; break; }
done
if [ -z "$src" ]; then
	src="$work/jsmin.c"
	curl -sfL --proto '=https' --proto-redir '=https' \
		"https://raw.githubusercontent.com/openwrt/luci/$LUCI_PIN/modules/luci-base/src/jsmin.c" -o "$src" \
		|| { echo "t0: cannot fetch jsmin.c — set LUCI_SRC to a luci checkout" >&2; exit 2; }
fi
# Checked whether it was downloaded or found locally: a checkout sitting on a different commit is
# exactly the drift this pin exists to catch.
echo "$JSMIN_SHA256  $src" | sha256sum -c - >/dev/null 2>&1
ok $? "jsmin.c matches the pin  ($LUCI_PIN)"

cc -O2 -o "$work/jsmin" "$src" 2>/dev/null
ok $? "jsmin builds"

# ---- the modules ------------------------------------------------------------
for f in "$RES"/*.js; do
	n=$(basename "$f")
	node -e "new Function(require('fs').readFileSync('$f','utf8'))" 2>/dev/null
	ok $? "  $n parses"

	"$work/jsmin" < "$f" > "$work/min.js" 2>/dev/null
	node -e "new Function(require('fs').readFileSync('$work/min.js','utf8'))" 2>/dev/null
	ok $? "  $n parses after jsmin" "$(wc -c < "$work/min.js") bytes out of $(wc -c < "$f")"
done

# ---- the shell --------------------------------------------------------------
for f in "$PKG"/root/etc/uci-defaults/* "$PKG"/update-po.sh tools/*.sh; do
	[ -f "$f" ] || continue
	sh -n "$f" 2>/dev/null
	ok $? "  $(basename "$f") parses"
done

# ---- the probes -------------------------------------------------------------
for f in tools/*.mjs; do
	[ -f "$f" ] || continue
	node --check "$f" 2>/dev/null
	ok $? "  $(basename "$f") parses"
done

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
