# CLAUDE.md

`luci-app-footstrap-files` — a file manager page for LuCI on **OpenWrt 24.10 and newer**. Its own
repository, its own tags, its own version: it does not track the theme's.

**Communicate in Russian.** Code, comments, commit messages and PR text stay in English.

**Repo root is the workspace** (`tools/`, `owfeed.yml`, `dist/`); the shipped package is
`luci-app-footstrap-files/` one level down — same name, one level apart, so a path is ambiguous
unless it is absolute or rooted. Nothing in the root ships.

## What this package is

One LuCI view plus a vendored editor. No ubus backend of its own: everything goes through
luci-base's `fs` API (`list`/`stat`/`read`/`write`/`remove`/`exec`), `fs.read_direct` and
`cgi-upload`. The ACL grants **root over the whole filesystem** — that is what a file manager is —
so every change here is a change to something running as root, and `/security-review` before a
release is not optional.

| File | What it is |
|---|---|
| `htdocs/luci-static/resources/view/footstrap-files/browser.js` | the page: listing, toolbar, operations, the editor panel |
| `htdocs/luci-static/resources/view/footstrap-files/editor.js` | the editor, assembled by hand out of prism-code-editor |
| `htdocs/luci-static/footstrap-files/files.css` | one `@layer footstrap-files`, `--fs-*` tokens WITH fallbacks so it is right under any theme |
| `htdocs/luci-static/footstrap-files/vendor/pce/` | third-party, vendored verbatim, **not ours to edit or minify** |
| `root/usr/share/luci/menu.d/`, `root/usr/share/rpcd/acl.d/` | the menu node and the grant |

## Rules with a reason

- **The listing is a LuCI `.table`** — `.tr`/`.th`/`.td` with `data-title` on every cell. That is
  what makes it card up on a phone under Footstrap and inherit any other theme's table styling. A
  grid of our own would also make the theme leave it alone (footstrap
  `docs/third-party-apps.md` rule 9), which is exactly how the stock file manager ends up as a
  598px box in a 1224px column.
- **`fs.exec` takes an ARGUMENT ARRAY and `--` before the operands.** Never a shell string. A file
  named `; reboot;` is then an argument; a file named `-rf` is then a file.
- **`cp -a`, not `cp -r`**, and `-n` on every paste: modes and symlinks survive, and nothing is
  overwritten without being asked.
- **Recursive delete is offered only after ubus refuses**, and asks a second time naming the
  directory. `chmod -R` is a checkbox and never the default.
- **Nothing is written into `<head>`.** Stylesheets are `<link>`s inside the view's tree, so they
  die with `#view`; the editor's own styles live in its shadow root. A sheet in `<head>` survives an
  SPA navigation and repaints somebody else's page — the trap the theme documents.
- **E() sets text, never markup.** A file name is data. There is no `innerHTML` on this page and
  there must not be one.
- **The vendored editor is pruned by reachability**, not by hand: `setups/index.js` pulls a barrel
  that imports every grammar (263 files, measured). Adding a language means adding
  `prism/languages/<lang>.js` AND `languages/<lang>.js` and re-running the prune.

## Commands

```sh
tools/t0.sh                                  # T0: every module parses, before and after jsmin
FOOTSTRAP_VERSION=x.y.z ./tools/stage.sh     # dist/root + dist/VERSION + dist/scripts + dist/i18n-*
owfeed build                                 # both formats into dist/
./luci-app-footstrap-files/update-po.sh      # rescan strings; --check is the gate
owlab status                                 # the theme's stands are used for testing this too
```

## Verifying

- **T0, always**: `tools/t0.sh`, plus `update-po.sh --check` after touching any `_()`.
- **T2, on a real router**: install the built `.apk` on 25.12 and the `.ipk` on 24.10 — both, every
  release. A page that renders under `owlab sync` proves nothing about the package.
- **Every operation is checked against the router's own filesystem**, not against what the page
  says: create, rename, copy, move, delete, chmod, chown, upload, download, save. The page reporting
  success while `ls -l` disagrees is the failure mode that matters here.

## Commits

Conventional Commits, message in English. **Never commit or push without an explicit instruction for
that action, each time.** No AI attribution trailers.
