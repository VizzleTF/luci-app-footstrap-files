#
# Copyright (C) 2026
#
# This is free software, licensed under the Apache License, Version 2.0 .
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-footstrap-cmd
# luci.mk keys hook names on LUCI_NAME, which defaults to the checkout's directory name — a
# differently-named checkout symlinked into the feed would silently skip the Build/Prepare hook.
LUCI_NAME:=luci-app-footstrap-cmd

# Version is git-derived; never hardcode PKG_VERSION. CI injects FOOTSTRAP_VERSION from the tag (an
# SDK build has no .git, so it cannot derive one). This package has its own repo and its own tags:
# the number here is this package's alone and does not track the theme's.
FOOTSTRAP_VERSION?=
ifneq ($(FOOTSTRAP_VERSION),)
PKG_VERSION:=$(FOOTSTRAP_VERSION)
PKG_RELEASE:=1
endif

LUCI_TITLE:=A `:` command line and section search for the Footstrap theme
# +luci-theme-footstrap: every module here is loaded BY the theme's chrome (it requires whatever
# `footstrap.settings.plugin` names) and three of them require the theme's own fs-menutree,
# fs-router and fs-prefs. Installed without the theme this package is inert, not broken — but there
# is no reason to carry it, so the dependency is stated. +luci-base is transitive, stated for
# clarity.
#
# NO dependency on luci-mod-system or luci-mod-network, deliberately: every command is gated at RUN
# time on the menu node whose `depends.acl` names the group it needs, so a router without those
# modules simply offers fewer commands. A hard dependency would install them instead.
LUCI_DEPENDS:=+luci-base +luci-theme-footstrap
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=VizzleTF <vizzletf47@gmail.com>
LUCI_URL:=https://github.com/VizzleTF/luci-app-footstrap-cmd
LUCI_DESCRIPTION:=Adds a vim-style `:` command line and search over the sections inside a page to \
the Footstrap theme. Client-side only, and it ships no ACL of its own: every command runs against \
an ubus object some LuCI module already grants, and is offered only when the menu node carrying \
that group is present in the session's own menu.

PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE

# CSS: ship verbatim. luci.mk defaults LUCI_MINIFY_CSS to 1, which runs csstidy over every *.css
# under htdocs/ — and csstidy predates @layer by fifteen years. Measured on this package's sheet,
# csstidy 1.x, `--template=highest --remove_last_semicolon=true`: 3851 bytes in, 1327 out, EXIT 0.
# It drops the `@layer theme { … }` wrapper and the `.fs-cmd` rule inside it whole (so the bar
# loses position, z-index, background, blur and shadow and renders as an unstyled block in the page
# flow), reduces @keyframes to a stray `to{…}` selector, and rewrites
# `@media (prefers-reduced-motion: reduce)` into invalid `@media prefers-reduced-motion reduce`.
# The theme states the same requirement in docs/package.md and gates it in CI.
# The sheet is ~120 lines and hand-written; a minifier has nothing to win here.
LUCI_MINIFY_CSS:=0

# THIS PACKAGE SHIPS NO ACL FILE, and that is the design rather than an omission. Every command it
# offers runs against an ubus object some LuCI module already grants — `rc list`/`rc init` from
# luci-mod-system-init, `system reboot` from luci-mod-system-reboot, `/bin/ping` from
# luci-mod-network-diagnostics — and each is shown only when the MENU NODE that carries that ACL
# group is present in the session's own /admin/menu blob. A grant of its own would hand every
# holder of this package's group a permission their LuCI account was never given.

# RELOAD, NOT RESTART: rpcd holds sessions in memory, so `restart` logs out every LuCI user while
# `reload` re-reads the ACLs and keeps them.
#
# This package ships no acl.d of its own, so for a while there was nothing here to refresh and this
# script only dropped the caches. That was wrong for a reason that took a live stand to see: the
# uci-defaults script CREATES /etc/config/footstrap when the theme has not got there first, and an
# rpcd already running does not cover a uci package whose file did not exist when it read its ACLs.
# The symptom is the theme's Appearance tab answering `uci/get failed with error -32002: Access
# denied` — a permission error for a config the session is fully entitled to read.
#
# The caches go for a separate reason: the chrome otherwise keeps serving the page a list of
# plugins that predates this install.
define Package/luci-app-footstrap-cmd/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* >/dev/null 2>&1 || true
	/etc/init.d/rpcd reload >/dev/null 2>&1 || true
}
exit 0
endef

# Removing the package leaves `footstrap.settings.plugin` naming a module that is no longer on disk;
# the chrome logs the failed require and carries on, but the config would stay wrong forever.
define Package/luci-app-footstrap-cmd/postrm
#!/bin/sh
# opkg runs the OLD package's postrm with arg "upgrade" during a version upgrade and "remove" on a
# real removal. On upgrade this script MUST change nothing: de-registering the plugin here would
# leave the upgraded package installed and unlisted, so the chrome never requires it and the `:`
# key does nothing until someone re-runs uci-defaults by hand. This is the same trap that once
# flipped every updating 24.10 user off the theme. apk never runs this on upgrade (it uses the new
# package's pre/post-upgrade), so guarding on the arg is correct for both managers.
case "$$1" in *upgrade*) exit 0 ;; esac
[ -n "$${IPKG_INSTROOT}" ] || {
	uci -q del_list footstrap.settings.plugin=fs-cmd && uci -q commit footstrap
	rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* >/dev/null 2>&1 || true
}
exit 0
endef

# Absolute, not a relative path: CI rsyncs this package into package/, not into the feed.
include $(TOPDIR)/feeds/luci/luci.mk

# luci.mk's Build/Prepare copies only src/ luasrc/ htdocs/ root/ ucode/ into $(PKG_BUILD_DIR), and
# PKG_LICENSE_FILES resolves against THAT — so the Apache text has to be put there by hand or the
# declaration above points at nothing. The hook name is keyed on LUCI_NAME, which is pinned at the
# top for exactly this reason.
define Build/Prepare/luci-app-footstrap-cmd
	$(CP) $(CURDIR)/LICENSE $(PKG_BUILD_DIR)/
endef

# THE LINE BELOW IS LOAD-BEARING AND IT IS NOT A SIGNATURE — do not delete it as boilerplate.
# include/scan.mk builds the package list by GREPPING Makefiles for `call BuildPackage`; luci.mk calls
# it at the include above, but the grep cannot see that, so this literal is what puts the package into
# the SDK's list.
# call BuildPackage - OpenWrt buildroot signature
