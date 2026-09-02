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
| `htdocs/luci-static/resources/view/footstrap-files/files.css` | unlayered and `.fsf-*`-scoped; colour from the export tier with literal fallbacks, spacing and radius as plain values |
| `htdocs/luci-static/resources/view/footstrap-files/vendor/pce/` | third-party, vendored verbatim, **not ours to edit or minify** |
| `root/usr/share/luci/menu.d/`, `root/usr/share/rpcd/acl.d/` | the menu node and the grant |

## Read this before touching the styling

**`docs/luci-app-styling-guide.md` in the theme's repository is the contract for an app**, and it is
outward-facing: it is written for exactly this package. It was not read when this page was first
written, and the page broke every rule it cares about — the tokens, the dark-mode signal, and the
table markup. The three that cost the most:

- **Colour comes from the 26 `--*-color-*` export names, never from `--fs-*`.** Those are the theme's
  PRIVATE tier: renamed whenever it wants, absent from every other theme. Spacing, radius and type
  are not on the tier at all, so they are literals here.
- **Dark mode is asked of the THEME**, in the order `data-darkmode` → `data-theme` → `data-bs-theme`
  → the luminance of `body`. `prefers-color-scheme` reports the operating system and is the wrong
  question. Verified on the stand with the OS light and the theme dark: the editor loads
  `github-dark.css` and the page's own surfaces come out dark.
- **Stock markup, not a lookalike.** A LuCI table is a real `<table class="table">` with
  `<tr class="tr">` and `<td class="td" data-title="…">` — the shape Active DHCP Leases uses. Built
  out of divs carrying the same class names, the browser wraps the rows in an anonymous table box
  that draws as an empty band above the header.

## Rules with a reason

- **One click opens; selecting several is a MODE.** The model is the iOS Files app, because that is
  the one a phone can drive: a tap opens, a long press (500 ms, 10 px of travel allowed) opens the
  menu, and its **Select** turns on a mode where a tap ticks and a bar carries the count, Copy, Move,
  Delete and Done. A mouse does not wait for the mode — Ctrl/Cmd+click toggles, Shift+click takes the
  range — and using either turns it on so the bar appears. The pivot rule is Explorer's: a plain or
  Ctrl+click MOVES the anchor, Shift+click does not, and each Shift+click recomputes from the anchor
  rather than extending the last result.
- **`metaKey || (ctrlKey && !mac)`, never `ctrlKey` alone.** On macOS Ctrl+click is the system's
  context menu and the `click` may never arrive.
- **iOS Safari sends no `contextmenu` at all**, so the long-press timer is the only way into the menu
  there; `-webkit-touch-callout: none` (coarse pointers only) is what stops the system callout from
  opening on top of it, and `preventDefault()` on `touchend` is what stops the synthetic click from
  opening the file underneath.
- **iOS suspends JS timers while a scroll and its momentum run**, so a long press begun just after
  scrolling never reaches its 500 ms callback — reported from a real iPhone as "no menu on
  /etc/config, only after scrolling". `touchend` therefore measures the elapsed time itself and opens
  the menu on release. Proved with the 500 ms timer stubbed out in the page (`tools/probe.mjs`).
- **A `contextmenu` event can carry no coordinates** — the menu key and Shift+F10 send 0/0 — and the
  arithmetic then yields `NaNpx`, which the browser drops and the menu lands wherever its static
  position falls. Without coordinates it is anchored under the row.
- **Select mode owns the toolbar, and an action ends it.** A second bar under the first pushed the
  listing down on every tick; ticking now repaints classes only (`paintSelection`), measured at 0px
  of scroll and 0px of height change.
- **The anchor is a PATH, not an index**, and the selection is intersected with what is on screen
  after every refresh: a poll or an operation redraws the listing, and a stale index would make
  Delete act on something the reader cannot see.

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
