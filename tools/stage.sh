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

# 2. The JS and the CSS, minified over the STAGED copy — never over the checkout.
#
#    terser, not jsmin: jsmin strips comments and whitespace only, while identifiers are wire bytes
#    and uhttpd serves /www with no compression. Measured on this tree, jsmin gets 71,650 bytes down
#    to 33,559 and terser to 29,016 — and the sheet, which csstidy is not allowed near (see
#    LUCI_MINIFY_CSS:=0 in the Makefile), goes 17,174 -> 5,149 through tools/minify-css.sh.
#
#    THIS STEP USED TO DO NOTHING AT ALL. It globbed `resources/fs-cmd*.js`, a path copied from the
#    sibling package, matched no file, and `[ -f ] || continue` swallowed it: v0.1.0 shipped all
#    three files verbatim (65,776 + 6,018 + 17,174 bytes, read back out of the released .ipk). The
#    minifiers below fail the build when they are handed nothing, which is what makes that silence
#    impossible to repeat.
#
#    The SDK path is NOT changed and still runs jsmin over the sources (LUCI_MINIFY_JS is left at
#    its default) — a buildbot has no node. The two paths therefore ship different bytes for the
#    same commit, and both are gated: tools/t0.sh parses the jsmin output, tools/minify-js.mjs
#    parses its own and refuses to write a file whose module seam it changed.
VIEW="$STAGE/www/luci-static/resources/view/footstrap-files"
[ -d "$VIEW" ] || { echo "stage: nothing staged at $VIEW" >&2; exit 1; }

command -v node >/dev/null 2>&1 || { echo "stage: node not found — it is what minifies the payload" >&2; exit 1; }
[ -d "$ROOT/node_modules/terser" ] || {
	echo "stage: terser is missing — run \`npm ci\` (or \`npm install\`) in $ROOT first" >&2
	exit 1
}

# `vendor/` is skipped inside minify-js.mjs: it is third-party ES-module code, shipped verbatim,
# already minified by its own build, and jsmin/terser are not ours to point at it.
node "$ROOT/tools/minify-js.mjs" "$VIEW"

# Only OUR stylesheet. The vendored CSS beside it (layout.css, search.css, the two themes) comes
# minified out of prism-code-editor's own build.
sh "$ROOT/tools/minify-css.sh" "$VIEW/files.css"

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
