#!/bin/sh
# Stage this package's rootfs for owfeed — the half of the build owfeed deliberately does not do.
#
#   ./tools/stage.sh                      # dist/root + dist/VERSION + dist/scripts + dist/i18n-*
#   FOOTSTRAP_VERSION=0.1.0 ./tools/stage.sh
#
# `owfeed build` packages a DIRECTORY; it does not build one. Everything luci.mk would do on the way
# in — the install mapping, the JS minification, the version stamp, the lifecycle scripts — has to
# happen before it. The one step it does NOT do is the catalogue: owfeed compiles the .po itself,
# byte-identical to po2lmo, and requiring po2lmo would put a C build of luci-base in front of anyone
# packaging this.
#
# Why not the SDK, when tools/t2-*.sh prove an SDK build works: this package is noarch — browser JS,
# one stylesheet and a shell script, not one compiled byte — and the SDK spends about five minutes
# per format downloading and verifying a cross toolchain in order to run `cp`, twice, because 24.10
# and 25.12 are different containers. The SDK path stays as a GATE (it is what T2 exercises, and it
# is how anyone else can build this from an OpenWrt tree); nothing released comes from one.
#
# luci-app-footstrap-files/Makefile stays and is not a second source of truth: the lifecycle scripts
# are EXTRACTED from it below, so the two paths cannot disagree about what happens at install time.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/luci-app-footstrap-files"
DIST="$ROOT/dist"
STAGE="$DIST/root"

rm -rf "$DIST"
mkdir -p "$STAGE/www" "$DIST/scripts"

# 1. luci.mk's install mapping, and only it: htdocs -> /www, root -> /. There is no ucode/ or
#    luasrc/ here; a directory that appears later and is not copied would be a package missing half
#    of itself, so the copy is explicit rather than a wildcard over the package directory.
cp -a "$SRC/htdocs/." "$STAGE/www/"
cp -a "$SRC/root/." "$STAGE/"

# 2. The JS, through the SAME jsmin the OpenWrt buildbot runs — pinned by commit and checksummed in
#    luci-upstream.pin, exactly as tools/t0.sh does it. Without this owfeed would ship the sources
#    verbatim: 67 KB instead of 26 KB on a router's flash, and different bytes from what the SDK
#    path produces for the same commit.
#
#    The CSS is shipped VERBATIM and that is deliberate — the Makefile sets LUCI_MINIFY_CSS:=0
#    because csstidy drops this sheet's whole `@layer theme` block while exiting 0. owfeed runs no
#    csstidy, but shipping the same bytes down both paths is the point.
# shellcheck disable=SC1091
. "$SRC/luci-upstream.pin"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

jsmin_src=''
for c in "${LUCI_SRC:-}/modules/luci-base/src/jsmin.c" "$ROOT/../luci/modules/luci-base/src/jsmin.c"; do
	[ -f "$c" ] && { jsmin_src="$c"; break; }
done
if [ -z "$jsmin_src" ]; then
	jsmin_src="$work/jsmin.c"
	curl -sfL --proto '=https' --proto-redir '=https' \
		"https://raw.githubusercontent.com/openwrt/luci/$LUCI_PIN/modules/luci-base/src/jsmin.c" \
		-o "$jsmin_src" || { echo "stage: cannot fetch jsmin.c" >&2; exit 1; }
fi
echo "$JSMIN_SHA256  $jsmin_src" | sha256sum -c - >/dev/null 2>&1 || {
	echo "stage: jsmin.c does not match luci-upstream.pin ($LUCI_PIN)" >&2
	exit 1
}
cc -O2 -o "$work/jsmin" "$jsmin_src"

for f in "$STAGE"/www/luci-static/resources/fs-cmd*.js; do
	[ -f "$f" ] || continue
	"$work/jsmin" < "$f" > "$f.min"
	# jsmin eats the rest of a file after a regex literal that follows `return` or `=>`, and EXITS
	# 0. Parsing the output is the only check that catches it; a release must never be the first
	# place that runs.
	node -e "new Function(require('fs').readFileSync('$f.min','utf8'))" 2>/dev/null || {
		echo "stage: $(basename "$f") does not parse after jsmin — refusing to package it" >&2
		exit 1
	}
	mv "$f.min" "$f"
done

# 3. The version. CI passes the tag; a working tree takes the newest tag so a local `owfeed build`
#    produces something plausible rather than nothing. `-r1` is what PKG_RELEASE:=1 puts on every
#    asset name in the SDK path, and the two must agree.
VER="${FOOTSTRAP_VERSION:-}"
if [ -z "$VER" ]; then
	VER=$(git -C "$ROOT" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//') || true
fi
[ -n "$VER" ] || { echo "stage: no FOOTSTRAP_VERSION and no tag to derive one from" >&2; exit 1; }
printf '%s-r1\n' "$VER" > "$DIST/VERSION"

# 4. The lifecycle scripts, out of the Makefile's own defines. owfeed wraps them the way
#    package-pack.mk does (default_postinst, default_prerm), so what is extracted is the BODY only —
#    the same text the SDK build appends to that wrapper. `$$` is make's escaping for a literal `$`.
extract() {			# <define-suffix> <outfile>
	awk -v want="define Package/luci-app-footstrap-files/$1" '
		$0 == want { in_block = 1; next }
		in_block && $0 == "endef" { exit }
		in_block { print }
	' "$SRC/Makefile" | sed 's/\$\$/$/g' > "$2"
	[ -s "$2" ] || {
		echo "stage: no Package/luci-app-footstrap-files/$1 block in the Makefile — refusing to" >&2
		echo "       build a package whose install-time half is silently missing" >&2
		exit 1
	}
}
extract postinst "$DIST/scripts/post-install"
extract postrm   "$DIST/scripts/post-deinstall"
chmod +x "$DIST/scripts/"*

# 5. One staging pair per language: the .po owfeed compiles, and the rootfs of the catalogue package
#    — which carries nothing but the uci-defaults line that puts the language in LuCI's menu, the
#    same line luci.mk writes for its own i18n subpackages.
# LuCI's OWN display name for the language, which is what its dropdown shows. luci.mk takes it
# from its LUCI_LANG.<code> table; writing the CODE instead puts a literal "ru" in the menu where
# every other catalogue puts "Русский (Russian)". Unknown codes fail rather than ship that.
lang_name() {
	case "$1" in
		ru) echo 'Русский (Russian)' ;;
		*)  echo '' ;;
	esac
}
for d in "$SRC"/po/*/; do
	lang=$(basename "$d")
	[ "$lang" = templates ] && continue
	[ -f "$d/footstrap-files.po" ] || continue
	label=$(lang_name "$lang")
	[ -n "$label" ] || {
		echo "stage: po/$lang has no label in lang_name() — add LuCI's own LUCI_LANG.$lang" >&2
		exit 1
	}
	# po-<lang>/<lang>/: owfeed reads the catalogue out of a directory named for the language, the
	# same shape the theme stages.
	mkdir -p "$DIST/po-$lang/$lang" "$DIST/i18n-$lang/etc/uci-defaults"
	cp "$d/footstrap-files.po" "$DIST/po-$lang/$lang/"
	printf "uci set luci.languages.%s='%s'; uci commit luci\n" \
		"$(echo "$lang" | tr - _)" "$label" \
		> "$DIST/i18n-$lang/etc/uci-defaults/luci-i18n-footstrap-files-$lang"
	chmod +x "$DIST/i18n-$lang/etc/uci-defaults/luci-i18n-footstrap-files-$lang"
done

echo "staged $(cat "$DIST/VERSION") into $DIST"
