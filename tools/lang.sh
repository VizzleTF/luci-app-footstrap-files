#!/bin/sh
# luci.mk's LUCI_LC_ALIAS, for the languages this package carries: the name a catalogue's PACKAGE,
# its .lmo and its `luci.languages` key take when that differs from the po/ directory. The directory
# stays luci.mk's and Weblate's (`po/zh_Hans`); everything a router sees says `zh-cn`, because that
# is what `luci-i18n-base-zh-cn` says and an install-if on any other name never fires.
# Sourced by stage.sh, i18n-packages.sh and check.yml.
lang_pkg() {
	case "$1" in
		zh_Hans) echo zh-cn ;;
		*)       echo "$1" ;;
	esac
}
