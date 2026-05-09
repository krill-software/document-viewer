# Document Viewer — Spec (v1)

A minimal, single-window Linux document viewer. Open a PDF, read it. Page thumbnails in a side panel. Step through pages with the keyboard. **The product is the calm** — the bar is `evince` minus the settings panel, not a Foxit-shaped power tool.

v1 reads PDFs. v2 adds Word.

## Naming (this app)

| Where        | Value                                       |
|--------------|---------------------------------------------|
| Slug         | `document-viewer`                           |
| Binary       | `krill-document-viewer`                     |
| Cargo lib    | `krill_document_viewer_lib`                 |
| productName  | `Document Viewer`                           |
| Identifier   | `software.krill.document-viewer`            |
| Directory    | `krill-software/document-viewer/`           |
| Repo         | `krill-software/document-viewer`            |
| State dir    | `$XDG_STATE_HOME/krill-document-viewer/`    |
| Lucide icon  | `file-text`                                 |

Convention lives in [STYLE.md](../STYLE.md) → Naming.

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
- **Open:** drag-drop onto window, CLI arg (`krill-document-viewer paper.pdf`), `Ctrl+O` dialog.
- **Recent files:** last 10, persisted in XDG state, reachable via `Ctrl+R` or a small recents submenu in the titlebar menu.
- **No save, no export.** Read-only viewer.

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
- `Ctrl+G` opens a small inline "Go to page" input (single field, enter to confirm). The only inline modal in v1.
- Clicking a sidebar thumbnail smooth-scrolls the main view to that page.
- The status line and the sidebar's active-page highlight follow the scroll position; they're observed state, not driven state.

### Viewport
- **Fit-to-width** is the default on every document load.
- **Zoom:** `Ctrl+=` / `Ctrl+-`, mouse-wheel with `Ctrl`, pinch on touchpads. `Ctrl+0` returns to fit-to-width, `Ctrl+1` snaps to 100% (one CSS pixel per PDF point).
- **No pan** in v1 — vertical scroll handles tall pages; horizontal overflow at zoom > fit just gets a scrollbar. (We can add click-drag pan if it feels missing.)

### Fullscreen
- `F` or `F11` enters chrome-free fullscreen: no titlebar, no menu, no thumbnail panel — just the page on a `--fm-bg` ground. `Esc` or the same key returns.
- Arrow keys still navigate while fullscreen.

### What the titlebar shows
- Centered: filename.
- Standard min/max/close on the right.

### What the status line shows
- A thin footer (~24px) along the bottom of the window.
- Right-aligned: `current / total` (e.g. `7 / 142`), plus zoom % when not at fit-to-width.
- Hidden in fullscreen.

## UX principles

1. **One window, one document.** Opening a second file from the OS launches a second window/process.
2. **Two chrome surfaces only.** Custom titlebar at the top (filename + window controls), thin status line at the bottom (page position). No toolbar, no rail outside the side panel.
3. **Keyboard-first, mouse-honest.** Every action has a key; thumbs and arrows are the discoverable mouse path.
4. **No modal dialogs.** Open is the only OS dialog. "Go to page" is inline, not modal.
5. **Fit-to-width always wins on load.** The user starts every document from the same baseline.

## Window chrome

- Custom titlebar (matches image-viewer / image-editor: drag region + min/max/close, inline menu).
- Window background: palette `--fm-bg`. Thumbnail panel: `--fm-bg` with a 1px `--fm-rule` divider on the right. Current-thumb border: `--fm-accent`.
- Status line at the bottom (~24px), Ghost White with a 1px `--fm-rule` top border, right-aligned `current / total` page indicator in `--fm-muted` mono.
- Default window: 1200 × 820, min 720 × 540 (smaller than that and the side panel + page can't both breathe).

## Keybindings (v1)

| Action | Key |
|---|---|
| Open | `Ctrl+O` |
| Recent files | `Ctrl+R` |
| Previous / next page | `←` / `→`, `PgUp` / `PgDn` |
| First / last page | `Home` / `End` |
| Go to page (inline) | `Ctrl+G` |
| Toggle thumbnail panel | `Ctrl+\` |
| Zoom in / out | `Ctrl+=` / `Ctrl+-` |
| Fit to width | `Ctrl+0` |
| Actual size (100%) | `Ctrl+1` |
| Fullscreen | `F` or `F11` |
| Close window | `Ctrl+W` |
| Quit | `Ctrl+Q` |

## File handling

- **Formats in (v1):** PDF only.
- **External changes:** not watched in v1. Reopen the file to pick up edits.
- **Symlinks:** followed.
- **Encrypted PDFs:** prompt for password inline (single field at the top of the main view); no password-saving in v1.

## Linux integration

- Binary name: `krill-document-viewer`.
- `.desktop` file with MIME types: `application/pdf`.
- Registered as a candidate handler, not the default — users opt in via "Open with…".
- Config: `$XDG_CONFIG_HOME/krill-document-viewer/config.toml` (empty in v1).
- State: `$XDG_STATE_HOME/krill-document-viewer/` — window geometry, recent files, last-known thumbnail-panel visibility.
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

1. **M1 — Skeleton + display.** Tauri app launches, opens a PDF via CLI arg / drag-drop / `Ctrl+O`, renders the first page fit-to-width in the custom-titlebar shell. No thumbnails, no navigation yet.
2. **M2 — Page navigation.** Arrow keys, `PgUp`/`PgDn`, `Home`/`End`, titlebar position indicator (`7 / 142`), `Ctrl+G` go-to-page.
3. **M3 — Thumbnail panel.** Side rail with lazy-rendered thumbnails, click-to-jump, current-page highlight, `Ctrl+\` toggle, persisted visibility.
4. **M4 — Zoom + fullscreen.** `Ctrl+=` / `Ctrl+-` / `Ctrl+0` / `Ctrl+1`, wheel-zoom, fit-to-width vs 100%, `F` / `F11` chrome-free mode, zoom % in titlebar.
5. **M5 — Recents + packaging.** Recent-files list in XDG state, `Ctrl+R` menu, `.desktop`, MIME association, AppImage + `.deb`, GitHub Actions release workflow, landing page. Mirror image-editor's `scripts/publish.sh`.
