# luci-app-footstrap-files

A file manager for OpenWrt's LuCI: browse the router's filesystem, upload and download, rename,
copy, move, change permissions, and edit text files with syntax highlighting.

Written for the [Footstrap](https://github.com/VizzleTF/luci-theme-footstrap) theme and usable under
any other — the page is ordinary LuCI markup and its stylesheet is a cascade layer of its own.

```sh
# 25.12 and newer (apk)
apk add luci-app-footstrap-files
# 24.10 (opkg)
opkg install luci-app-footstrap-files
```

Then **System → Files**.

## What it does

| | |
|---|---|
| Browse | breadcrumbs, sortable columns (name, type, size, permissions, modified), the path in the address bar so a directory can be bookmarked |
| Files | upload, download, rename, copy, move, delete, new file, new directory |
| Permissions | mode and owner, shown as `drwxr-xr-x root:root` and editable as `644` / `user:group`, optionally recursive |
| Edit | syntax highlighting, line numbers, find and replace, bracket matching; files up to 1 MB |
| Phone | the listing becomes a card per file, and the editor is a real `<textarea>` underneath, so the keyboard, IME and autocorrect are the ones the phone already has |

## What it does not do

No hex editor, no markdown preview, no drag-and-drop upload, no column resizing. Those are the parts
of the stock `luci-app-filemanager` this package deliberately leaves out for now.

## Permissions

This package asks for **full read and write access to the filesystem as root** — the same grant the
stock file manager takes:

```json
"file": { "/*": [ "list", "read", "write", "exec" ] }
```

That is what a file manager is, and it is worth stating plainly: anyone who can log into LuCI with
this package's ACL group can read and change any file on the router. Install it if that is what you
want; there is no setting that narrows it.

Operations ubus has no method for — `mkdir`, `mv`, `cp`, `chmod`, `chown` — are run through
`fs.exec` with an **argument array** and `--` before the operands, never a shell string. A file
called `; reboot;` or `-rf` is an argument, not a command and not a flag.

## The editor

[prism-code-editor](https://github.com/jonpyt/prism-code-editor) (MIT), assembled by hand rather
than through its ready-made setup: that setup pulls a barrel module which imports **every** grammar
the project ships — 263 files, measured. This package vendors the core, four grammars (`bash`,
`ini`, `json`, `nginx`), find-and-replace and bracket matching: **89 KB on flash, 30 files**, of
which 22 are fetched when a file is opened.

`/etc/config/*` is highlighted as shell rather than as INI, and that is not a shortcut: Prism's INI
grammar wants `key=value` and `[section]`, while uci writes `config interface 'lan'`. Measured on a
120-line `/etc/config/network`, the INI grammar tokenised nine things. A uci grammar of its own is a
later change.

The editor's stylesheets go into its shadow root, so nothing this page loads can reach the rest of
the document — which is the property that ruled out the alternatives.

## Building

```sh
FOOTSTRAP_VERSION=0.1.0 ./tools/stage.sh   # dist/root, dist/VERSION, dist/scripts, dist/i18n-*
owfeed build                               # dist/noarch/*.apk (25.12) + dist/all/*.ipk (24.10)
tools/t0.sh                                # parses every module, before and after the buildbot's jsmin
./luci-app-footstrap-files/update-po.sh    # rescan strings, merge into po/<lang>/
```

An OpenWrt SDK build works too — the `Makefile` is a normal `luci.mk` package — but nothing released
here comes from one.

## Licence

Apache-2.0. The vendored editor is MIT; its licence travels with it under
`htdocs/luci-static/footstrap-files/vendor/pce/LICENSE`.
