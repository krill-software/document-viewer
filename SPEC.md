# PDF Reader — Spec (v1)

A minimal, single-window Linux PDF reader. Open a PDF, read it. Page thumbnails in a side panel. Step through pages with the keyboard. **The product is the calm** — the bar is `evince` minus the settings panel, not a Foxit-shaped power tool.

v1 reads PDFs. v2 adds Word.

## Naming (this app)

| Where        | Value                                       |
|--------------|---------------------------------------------|
| Slug         | `pdf-reader`                                |
| Binary       | `krill-pdf-reader`                          |
| Cargo lib    | `krill_pdf_reader_lib`                      |
| productName  | `PDF Reader`                                |
| Identifier   | `software.krill.pdf-reader`                 |
| Directory    | `krill-software/pdf-reader/`                |
| Repo         | `krill-software/pdf-reader`                 |
| State dir    | `$XDG_STATE_HOME/krill-pdf-reader/`         |
| Lucide icon  | `file-text`                                 |

Convention lives in [STYLE.md](https://github.com/krill-software/.github/blob/main/STYLE.md) → Naming.

## Goals

- Open a PDF and start reading instantly. Cold launch to first page under ~300 ms on a typical Linux laptop.
- See where you are in the document at a glance — a thumbnail rail to the side, current page highlighted.
- Page through with the keyboard the way every reader-app user already expects.
- Render the PDF truthfully — fit-to-width by default, zoom on demand.
- Feel like a native Linux desktop app (`.desktop` entry, file association, XDG dirs).

## Non-goals (v1)

- **No editing.** No annotations, no highlights, no comments, no form filling, no signing.
- **No search (`Ctrl+F`).** Text *selection and copy* are in (PDF.js text layer over each page); a search UI is a separate feature, deferred.
- **No multi-document tabs.** One window per document — krill rule.
- **No outline / bookmarks panel.** Side panel is thumbnails only.
- **No print, no export.** Read-only viewer.
- **No EPUB, no Markdown rendering, no DjVu.** Out of scope; different shapes of app.
- **No settings panel, no preferences, no theme switcher.**
- **No Windows/macOS builds.**

## Stack

- **Shell:** Tauri 2 (Rust backend + system webview). Mirrors image-viewer.
- **Frontend:** TypeScript + Vite.
- **Chrome + palette:** [`@krill-software/desktop-ui`](https://github.com/krill-software/desktop-ui) (git dep). Provides the locked-palette CSS bundle, custom titlebar, menu bar, and status line via `mountChrome()`. The app's own `styles.css` only carries app-specific layout (viewport, sidebar, page rendering).
- **PDF rendering:** [PDF.js](https://mozilla.github.io/pdf.js/) (Mozilla, Apache-2.0). Bundled into the frontend; the webview does all the rendering.
- **File I/O:** Rust reads the PDF file, hands the bytes to the frontend via a Tauri command. Same channel for opening from CLI arg, drag-drop, or `Ctrl+O`.

Rationale: PDF.js is mature, has thumbnails support out of the box, no system dependencies, and keeps Rust's job small (just file reading + state). v2 (Word) will need a different renderer; we'll re-decide the engine then.

## Architecture

```
[CLI arg / drag-drop / Open dialog]
        │
        ▼
  Rust: read file bytes, return them to frontend
        │
        ▼
  Frontend: pdf.js loads document, renders pages on demand
        │
        ▼
  Side panel: per-page <canvas> thumbnails (rendered low-DPI)
  Main view:  current page <canvas> at full DPR, fit-to-width by default
        │
        ▼
  Arrow keys / scroll / thumb click  ──►  jump to page
```

- **Lazy thumbnail rendering.** Render the first ~20 thumbnails eagerly, then fill in the rest as the user scrolls the side panel. Avoids freezing the app on a 500-page document.
- **Continuous scroll in the main view.** All pages stack vertically and render lazily as they scroll into view. Active-page state is derived from scroll position, not the other way around — `goToPage(n)` is implemented as smooth-scroll, and arrow keys / sidebar clicks both go through it.
- **No decoding fallbacks.** If PDF.js can't parse the file, show "Can't open this PDF" with the filename. No alternative engine in v1.

## Features (v1)

### File I/O
- **Open:** drag-drop onto window, CLI arg (`krill-pdf-reader paper.pdf`), `Ctrl+O` dialog.
- **No save, no export.** Read-only viewer.
- **No recent-files menu** in v1 — deferred. Re-opening a PDF goes through the file manager / CLI / drag-drop.

### Side panel (thumbnails)
- Vertical strip on the left, ~140 px wide.
- Each thumbnail is a low-DPI render of the page, centered, with a small page number below.
- Current page is highlighted with the accent border (`--fm-accent`).
- Click a thumbnail → main view jumps to that page.
- Hideable with `Ctrl+\` (matches the muscle memory of "toggle sidebar" in IDEs and PDF readers).
- Default state on first launch: visible. Persisted across sessions.

### Main view (continuous scroll)
- All pages stack vertically, each fit-to-width with a 16 px gutter between them.
- Scrolling moves smoothly through the document — there's no page-flip step, no gesture to dismiss the current page. The active page is whichever has the most pixels in view.
- Pages render lazily as they enter the viewport (rootMargin 600 px so they're ready before they're visible). A 500-page PDF doesn't block load.
- Page rows pre-allocate vertical space using the document's first-page aspect ratio, so the scrollbar height is roughly correct from the moment the doc opens.
- **Text is selectable and copyable.** Each rendered page carries a transparent PDF.js text layer over the canvas, so the OS's native selection works — drag-select, `Ctrl+C`, double-click word, triple-click line. Selection extends across pages within the same document.

### Navigation
- `←` / `→` or `PgUp` / `PgDn` smooth-scroll to the previous / next page.
- `Home` / `End` smooth-scroll to the first / last page.
- Clicking a sidebar thumbnail smooth-scrolls the main view to that page.
- The status line and the sidebar's active-page highlight follow the scroll position; they're observed state, not driven state.
- **No `Ctrl+G` go-to-page** in v1 — deferred. Arrow keys and the sidebar handle position changes.

### Viewport
- **Fit-to-width** is the default on every document load.
- **Zoom:** `Ctrl+=` / `Ctrl+-`, mouse-wheel with `Ctrl`, pinch on touchpads. `Ctrl+0` returns to fit-to-width, `Ctrl+1` snaps to 100% (one CSS pixel per PDF point).
- **No pan** in v1 — vertical scroll handles tall pages; horizontal overflow at zoom > fit just gets a scrollbar. (We can add click-drag pan if it feels missing.)

### Fullscreen
- `F` or `F11` enters chrome-free fullscreen: no titlebar, no menu, no thumbnail panel — just the page on a `--fm-bg` ground. `Esc` or the same key returns.
- Arrow keys still navigate while fullscreen.

### What the titlebar shows
- Centered: filename.
- Standard menu (left) + min/max/close (right). Provided by `@krill-software/desktop-ui`.

### What the status line shows
- Provided by `@krill-software/desktop-ui` (34px, JetBrains Mono, 12px). Hidden in fullscreen.
- **Left (`statusInfo`)**: the app version, formatted `vX.Y.Z`. Suite convention — see krill STYLE.md → Status line.
- **Right (`statusState`)**: `current / total · zoom%` (e.g. `7 / 142 · 124%`). At fit-to-width, the zoom segment reads `100% (fit)` or whatever the fit scale resolves to, suffixed `(fit)`.

## UX principles

1. **One window, one document.** Opening a second file from the OS launches a second window/process.
2. **Two chrome surfaces only.** Custom titlebar at the top (filename + window controls), thin status line at the bottom (page position). No toolbar, no rail outside the side panel.
3. **Keyboard-first, mouse-honest.** Every action has a key; thumbs and arrows are the discoverable mouse path.
4. **No modal dialogs.** Open is the only OS dialog. "Go to page" is inline, not modal.
5. **Fit-to-width always wins on load.** The user starts every document from the same baseline.

## Window chrome

- Titlebar + status line: 44px / 34px, provided by `@krill-software/desktop-ui` (don't redeclare).
- Window background: palette `--fm-bg`. Thumbnail panel: `--fm-bg` with a 1px `--fm-rule` divider on the right. Current-thumb border: `--fm-accent`.
- Default window: 1200 × 820, min 720 × 540 (smaller than that and the side panel + page can't both breathe).

## Keybindings (v1)

| Action | Key |
|---|---|
| Open | `Ctrl+O` |
| Previous / next page | `←` / `→`, `PgUp` / `PgDn` |
| First / last page | `Home` / `End` |
| Toggle thumbnail panel | `Ctrl+\` |
| Zoom in / out | `Ctrl+=` / `Ctrl+-` |
| Wheel-zoom | `Ctrl + scroll` |
| Fit to width | `Ctrl+0` |
| Actual size (100%) | `Ctrl+1` |
| Fullscreen | `F11` (or via View menu) |
| Quit | `Ctrl+Q` |

Shortcuts not in this list (`Ctrl+G` go-to-page, `Ctrl+R` recents, `Ctrl+W` close window, `F` toggle-fullscreen) were considered and deferred for v1.

## File handling

- **Formats in (v1):** PDF only.
- **External changes:** not watched in v1. Reopen the file to pick up edits.
- **Symlinks:** followed.
- **Encrypted PDFs:** **not supported in v1.** Opening one shows an error state reading "Encrypted PDFs aren't supported yet." with the filename. A password prompt is deferred.

## Linux integration

- Binary name: `krill-pdf-reader`.
- `.desktop` file with MIME types: `application/pdf`.
- Registered as a candidate handler, not the default — users opt in via "Open with…".
- Config: `$XDG_CONFIG_HOME/krill-pdf-reader/config.toml` (empty in v1).
- State: `$XDG_STATE_HOME/krill-pdf-reader/` — window geometry and last-known thumbnail-panel visibility.
- Distribution: AppImage primary; `.deb` secondary.

## v2 — Word documents

Out of scope for v1, sketched here so the v1 architecture doesn't paint itself into a corner.

- **Formats added:** `.docx` first (the modern XML-zip format), then `.doc` if it's not too painful.
- **Renderer choice TBD.** Likely candidates:
  - [docx-rs](https://crates.io/crates/docx-rs) (Rust) → emit HTML → render in webview. Decent fidelity, all-Rust.
  - [LibreOffice headless](https://www.libreoffice.org) as a sidecar to convert `.docx` → PDF, then render through the v1 PDF path. Maximum fidelity, heavy dependency.
  - Browser-side mammoth.js → HTML. Fast to ship, lower fidelity for complex layouts.
- **Thumbnails for Word.** Each "page" of a Word document is a virtual concept (depends on layout, paper size, font availability). The PDF-conversion route gives us real pages for free; the HTML route forces us to invent pagination.
- **Likely call:** ship v2 via LibreOffice headless conversion. Heavy, but it's the only path with pixel-true fidelity for Word's quirks. Reassess at v2 scoping.

The v1 SPEC stays clean for PDF; v2 will get its own SPEC supplement when we get there.

## Out of scope / open questions

- **Search within document.** Defer; same data source as the text layer (already in v1), but the search UI/UX is its own feature.
- **Outline / bookmarks panel.** Tempting for academic PDFs. Defer; the brand is one chrome surface (thumbnails). Re-add only if user feedback strongly demands it.
- **Two-up / facing-pages view.** Defer. Single page is the calm default.
- **Right-to-left page order** (Arabic, Hebrew, Japanese tategaki). Defer; the scroll/arrow direction stays LTR in v1.
<!-- Continuous scroll: now the v1 default. Removed from out-of-scope. -->


## Milestones

1. **M1 — Skeleton + display.** Done. Tauri app launches, opens PDFs, renders the first page fit-to-width.
2. **M2 — Page navigation.** Done. Arrow keys, `PgUp`/`PgDn`, `Home`/`End`, position indicator. (`Ctrl+G` go-to-page deferred.)
3. **M3 — Thumbnail panel.** Done. Lazy-rendered side rail, click-to-jump, current-page highlight, `Ctrl+\` toggle, persisted visibility.
4. **M4 — Zoom + fullscreen.** Done. `Ctrl+=` / `Ctrl+-` / `Ctrl+0` / `Ctrl+1`, wheel-Ctrl zoom, fit-to-width vs scale, `F11` fullscreen, zoom % in status line.
5. **M5 — Packaging.** Done. `.desktop`, MIME association, AppImage + `.deb`, shared release workflow.
6. **M6 — Suite convention pass.** Done. Version in statusInfo, status combined as `page · zoom`, encrypted-PDF "not implemented" error.
