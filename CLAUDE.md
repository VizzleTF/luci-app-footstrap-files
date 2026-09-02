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
| `htdocs/luci-static/resources/view/footstrap-files/grammars.js` | OUR uci and shell grammars — the library's `bash` was 5.7 KB of the wrong language |
| `htdocs/luci-static/resources/view/footstrap-files/editor.css` | OUR editor colours, one file for both modes, off the export tier |
| `htdocs/luci-static/resources/view/footstrap-files/files.css` | unlayered and `.fsf-*`-scoped; colour from the export tier with literal fallbacks, spacing and radius as plain values |
| `htdocs/luci-static/resources/view/footstrap-files/vendor/pce/` | third-party, vendored verbatim — **not ours to edit**; minified on the way out (see below) |
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
- **A RUBBER BAND IS MOUSE-ONLY, and it needs a floor to start on.** Press on empty space and drag
  selects what the rectangle touches, with Ctrl/Shift adding to what was ticked — `pointerdown` is
  filtered on `pointerType === 'mouse'`, because on a touch screen that same gesture is how the
  listing scrolls. The band is `position: fixed` on `document.body` and compared against
  `getBoundingClientRect()`, so both are in viewport coordinates and no scroll arithmetic is needed.
  A table ends where its last row does — measured, the listing box and the table box were the same
  279px — so `.fsf-listing` carries `min-height: min(50vh, 26rem)`: without that floor there is
  nowhere to begin a band except on a row, where a press means dragging that row instead.
- **A CLICK ON EMPTY SPACE CLEARS THE SELECTION** — no band was drawn, so it was a click, and the
  reader pointed at nothing. Ctrl or Shift held is the exception: that is somebody adding to a
  selection and missing, and throwing the selection away would be the unkind reading.
- **A MOVE ASKS FIRST, naming the destination.** A drag is the easiest gesture here to make by
  accident — a press that travels four pixels — and it moves files as root. `confirm()`, the same
  as a delete, because "move 3 items" without saying where is not a question anybody can answer.
- **`..` IS A DROP TARGET IN BOTH VIEWS** and not a drag source: moving something up is as ordinary
  as moving it down, and without it the clipboard was the only way out of a directory. It carries no
  `data-path`, so the band and the selection never see it. The table's row and the grid's tile are
  built in different places — wiring only one of them made the gesture work in one view, which reads
  as a bug rather than as a limit.
- **A DROP HIGHLIGHT IS CLEARED EVERYWHERE, not just where it landed.** A row's drop calls
  `stopPropagation`, so the listing under it — highlighted on the way in, because `dragenter`
  bubbles — never saw the drop that would have cleared it, and unlike the rows the listing survives
  the refresh: a dashed frame stayed around the whole page until the next navigation. `drop` and
  `dragend` both call `clearDrops()`, which asks the DOM rather than a list of closures, because the
  rows those closures belonged to no longer exist after a redraw.
- **`dragleave` IS ANSWERED WITH `relatedTarget`, not with a counter.** It fires on every child the
  pointer crosses — a row is six cells and a span — so the naive listener drops the highlight while
  the pointer is still inside. A depth counter fixed that until a swallowed drop left the count
  above zero for ever; asking whether the element being entered is still inside is the same question
  without the state.
- **A DRAG CARRIES `this._dragging`, not `dataTransfer`.** The data in a `DataTransfer` cannot be
  read during `dragover` (and Safari hides custom types entirely), so the paths being dragged live
  in a field and the MIME type is set only for dropping outside the page. `dropTarget` tells the two
  apart: `dataTransfer.files` non-empty is an upload from the OS, otherwise it is a move from this
  listing. Dragging something already ticked takes the whole selection; dragging something else
  takes just it. `moveInto` refuses a directory dropped on itself or inside its own subtree — `mv
  /etc /etc/config` would take the source with it.
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
- **A FULL CLIPBOARD OWNS THE TOOLBAR TOO — but keeps the path.** Copy and Move used to paint a
  strip under the bar, which is a fourth row appearing the moment something is marked and, on a
  phone, the listing pushed down under the finger exactly as the reader goes looking for the
  destination. The bar now carries the count, **Paste here** and **Cancel** instead of the six file
  buttons that mean nothing with a full clipboard. Unlike select mode it does NOT take the whole
  bar: a paste acts on a directory the reader has still to walk to, so the path box, Go and Up stay.
  The count has its OWN class (`.fsf-clipcount`, not `.fsf-selcount`) — one class for both made a
  full clipboard indistinguishable from select mode to anything reading the page, and the probe went
  looking for a Done button that is not there.
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
  that imports every grammar (263 files, measured). What is left of it is the editor and the search
  widget — 17 files. Three things that used to come from it do not any more, and each was measured
  before it went:
  - `languages/*.js` (indent and comment rules) wrote into `languageMap`, **which nothing in this
    build reads** — the reader is `extensions/commands`, which we do not load. Proved on the stand:
    Enter inside a `{` gave a bare newline and Ctrl+/ did nothing, before and after. 3,970 bytes.
  - the `bash`, `ini` and `nginx` grammars: `grammars.js` has uci and shell of our own, and uci
    finally has keywords instead of being lexed as a shell script. 7,132 bytes.
  - `themes/github-*.css`: `editor.css` is one sheet on the export tier for both modes, so there is
    no `isDark()` and no swap. 6,492 bytes.
- **A NEW GRAMMAR GOES IN `grammars.js`**, not into `vendor/`. It is an ordered object of regexes —
  Prism tries them in turn — registered on `prism.languages` when the editor loads. NO LOOKBEHIND:
  Safari learned it in 16.4 and this package's floor is 15.4, so a name that follows a keyword is
  one match with an `inside`, never `(?<=…)`.
- **Editor colours are the THEME's**, from the same 26 export names the rest of the page uses, with
  a literal fallback on each. Nothing in `editor.css` may read `--fs-*`, and no `--pce-*` name that
  no vendored sheet reads belongs there — the library understands `--pce-ac-*`, `--pce-tabstop`,
  `--pce-bg-fold` and more, all of them for extensions this package does not load.
- **Find is a BUTTON because Ctrl+F is not a gesture a phone has.** The vendored widget opens on
  Ctrl+F, Cmd+F and F3 and on nothing else, so on touch the find-and-replace this package vendors
  could not be reached at all. The magnifier sits left of Save, is a toggle, and calls
  `editor.extensions.searchWidget.open(true)` — the `true` selects the field, which is what raises
  the keyboard. Whether it is open is asked of the DOM (`w.element.isConnected`): the library keeps
  `isOpen` private, and `open()`/`close()` add and remove that element.
- **Escape closes the WIDGET, and this page is what closes it.** The library binds its Escape to the
  editor's `wrapper`, and the widget is mounted as an overlay BESIDE that wrapper, so a keypress
  from the Find field never passes through it — proved on the 25.12 stand: the event reached window,
  document (capture and bubble) and the editor's root with nothing prevented, and the widget stayed
  open. A guard that merely stepped aside therefore left Escape doing nothing at all, with the
  widget dismissable only by mouse. `_escEdit` closes it itself and stops there; closing the dialog
  on that key would throw away an unsaved file. Verified on both stands and at three sizes.
- **The dialog's open-ness is `body.modal-overlay-active`, not a node count.** `ui.hideModal()`
  leaves the dialog's nodes in the document and takes that class off `<body>` — a probe that counts
  `.fsf-modal-actions` reports every dialog as permanently open.
- **One package per LANGUAGE, and the app package carries none.** A router that took the file
  manager has no reason to carry Russian, and a catalogue shipped inside the app is lost on the next
  upgrade with nothing saying why (measured on the theme). `tools/stage.sh` writes a pair per
  language — `dist/i18n-<lang>` (the uci-defaults line) and `dist/po-<lang>` (what owfeed compiles
  to .lmo) — and owfeed cuts `luci-i18n-footstrap-files-<lang>` from them. Adding a language means
  three edits, not one: `po/<lang>/`, `lang_name()` in stage.sh (LuCI's own display name, or the
  menu shows a bare code), and a package block in `owfeed.yml` with `files:`, `i18n.from:` and
  `install-if: [luci-app-footstrap-files={version}, luci-i18n-base-<lang>]`. Miss the last one and
  nothing fails: the catalogue is staged, packaged by nobody, and the language never reaches a
  router with the build still green — which is why `tools/i18n-packages.sh` compares the languages
  on disk against the packages declared for them, in both directions, and runs in T0 and in CI.
- **A HEX EDITOR EXISTS AND IT IS FETCHED ONLY WHEN OPENED.** `hex.js` is 2.8 KB against the stock
  app's 40 KB — the difference is its ASCII/HEX/RegExp search, its settings panel and the `<style>`
  it injects into the document. Virtual scrolling is not an optimisation here: at 16 bytes a line a
  1 MB file is 65,536 lines, so what exists is a spacer of the full height and a window of the lines
  on screen. The line height is MEASURED off a probe row, because a guess drifts a pixel per line.
- **A BINARY IS SAVED THROUGH ubus `file write` WITH `base64` AND `append`, never through
  cgi-upload.** Measured against the stand: one ubus message carries 16 KB and 64 KB is refused
  ("No related RPC reply"), so the save is chunked at 8 KB — 300 KB in 2.8 s. The reason it is not
  cgi-upload, which would do it in one request: upload REPLACES the file and an
  `-rw-r----- nobody:nogroup` came back `-rw------- root:root`. ubus writes into the existing inode
  and the mode and the owner survive. luci-base's own `fs.write` cannot do this — it does not
  declare the `base64` parameter, so this package declares its own `rpc.declare`.
- **NOTHING BUT THE LISTING LOADS WITH THE LISTING.** `editor.js`, `grammars.js`, `hex.js` and the
  whole vendored tree are `L.require`d at the moment a file is opened. This was not always true:
  editor.js and grammars.js were `require` pragmas and came down for every reader who only looked at
  a directory. A plain listing now fetches browser.js and files.css and nothing else — checked by
  watching the network, not by reading the code.
- **The payload is minified on the way out, never in the checkout.** `tools/stage.sh` runs
  `minify-js.mjs` (terser) over the view's own modules and `minify-css.sh` over `files.css`:
  110,255 bytes of payload become 68,534. The SDK path still uses jsmin, which is what T0 gates, so
  the two paths ship different bytes for one commit on purpose. The step this replaced globbed
  `resources/fs-cmd*.js`, a path copied from the sibling package, matched nothing and skipped
  minification in silence: v0.1.0 shipped the commented sources. CI now compares staged bytes
  against source bytes for all three files.
- **The vendored editor is minified too — as ES modules, and only in `dist/`.** prism-code-editor
  publishes its dist through rollup with code splitting and NO minifier: JSDoc, indentation, line
  breaks, 74,142 bytes of JS where terser reaches 30,219. The checkout keeps upstream's bytes so a
  diff against the next release stays readable. THE RISK IS THE MODULE SEAM: 25 files import each
  other by name (`import { a as languages } from "./core-DEy9UQvI.js"`), and a mangled export would
  leave a module importing something nobody exports, with nothing saying so until a reader opened a
  file on a router — so `tools/minify-vendor.mjs` compares every file's import and export lists
  before and after and refuses to write one whose seam moved, and CI re-checks the same thing
  against the staged tree. The vendored CSS is already minified by that build and ships verbatim.

## Commands

```sh
npm ci                                       # terser + acorn; stage.sh refuses to build without them
tools/t0.sh                                  # T0: every module parses, before and after jsmin
FOOTSTRAP_VERSION=x.y.z ./tools/stage.sh     # dist/root + dist/VERSION + dist/scripts + dist/i18n-*
owfeed build                                 # both formats into dist/
./luci-app-footstrap-files/update-po.sh      # rescan strings; --check is the gate
owlab status                                 # the theme's stands are used for testing this too
node tools/readme-shots.mjs                  # the README's four pictures, off a stand, both themes
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
