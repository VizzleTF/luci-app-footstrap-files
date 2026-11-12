#!/bin/sh
# ONE PACKAGE PER LANGUAGE, and nothing about a language in the app package.
#
#   tools/i18n-packages.sh
#
# A catalogue has to be its own package: a router that took the app has no reason to carry Russian,
# and — measured on the theme — a catalogue shipped INSIDE the app is lost on the next upgrade with
# nothing saying why. The split exists; what does not exist without this gate is the guarantee that
# it keeps holding for the NEXT language.
#
# The trap is that nothing fails when a language is half-wired. `po/de/` appears, tools/stage.sh
# writes dist/i18n-de and dist/po-de, and owfeed — whose package list is written by hand — packages
# neither. The build is green, the release is green, and German simply never reaches a router. So
# the two sides are compared here: the languages on disk against the packages declared for them.
set -eu
cd "$(dirname "$0")/.."

PKG=luci-app-footstrap-files
FEED=owfeed.yml
fail=0
. tools/lang.sh
note() { printf 'FAIL  %s\n' "$1" >&2; fail=1; }

langs=''
for d in "$PKG"/po/*/; do
	lang=$(basename "$d")
	[ "$lang" = templates ] && continue
	# The catalogue's basename is luci.mk's, not ours: `footstrap-files`.
	[ -f "$d/footstrap-files.po" ] || { note "po/$lang has no footstrap-files.po"; continue; }
	langs="$langs $lang"
done

[ -n "$langs" ] || note "no languages at all under $PKG/po/ — the i18n path is not being built"

pkgs=''
for lang in $langs; do
	# What the router calls the language, which is not always what po/ calls it: tools/lang.sh.
	pkg=$(lang_pkg "$lang")
	pkgs="$pkgs $pkg"
	name="luci-i18n-footstrap-files-$pkg"

	grep -qF "  - name: $name" "$FEED" \
		|| note "$name is not declared in $FEED — po/$lang would build a catalogue nobody packages"

	# The staging pair the package is made of. Both are written by tools/stage.sh from po/<lang>/.
	grep -qF "files: ./dist/i18n-$pkg" "$FEED" \
		|| note "$name declares no 'files: ./dist/i18n-$pkg' — the uci-defaults half is missing"
	grep -qF "from: ./dist/po-$pkg" "$FEED" \
		|| note "$name declares no 'from: ./dist/po-$pkg' — owfeed would compile no .lmo"

	# apk installs a catalogue by itself once the app and the language are both present; `depends`
	# alone points the wrong way and would never pull one in.
	grep -qF "\"luci-i18n-base-$pkg\"" "$FEED" \
		|| note "$name has no install-if on luci-i18n-base-$pkg — a $lang router would never get it"

	# LuCI's OWN display name, or the language lands in the menu as a bare code.
	grep -qE "^[[:space:]]*$lang\)" tools/stage.sh \
		|| note "tools/stage.sh lang_name() does not know '$lang' — staging refuses to build it"
done

# …and the other direction: a package declared for a language whose catalogue was deleted.
for name in $(grep -oE '^  - name: luci-i18n-footstrap-files-[a-z_-]+' "$FEED" | awk '{print $3}'); do
	pkg=${name#luci-i18n-footstrap-files-}
	case " $pkgs " in
		*" $pkg "*) ;;
		*) note "$FEED declares $name but no catalogue under $PKG/po/ builds it" ;;
	esac
done

# THE APP PACKAGE CARRIES NO LANGUAGE. Checked against the SOURCE tree the app package is made of,
# so it holds whether or not anything has been staged.
if find "$PKG/htdocs" "$PKG/root" -name '*.lmo' -o -name '*.po' | grep -q .; then
	note "a catalogue lives inside the app package's own tree — it belongs to luci-i18n-*"
fi

[ "$fail" = 0 ] && printf 'i18n-packages: %s language(s) —%s — each its own package\n' \
	"$(echo $langs | wc -w | tr -d ' ')" "$langs"
exit $fail
