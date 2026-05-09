# Document Viewer

A minimal, single-window document viewer for Linux. Open a PDF, read it. Page thumbnails in a side panel. Step through pages with the keyboard.

Built on Tauri 2 (Rust + system webview) with a TypeScript frontend. PDF rendering via [PDF.js](https://mozilla.github.io/pdf.js/) inside the webview; Rust does only file I/O and state. See [SPEC.md](SPEC.md) for the design rationale.

v1 reads PDFs. v2 will add Word.

## Features

- **Open** — drag-drop, CLI arg, `Ctrl+O`. Formats (v1): PDF.
- **Fullscreen** — `F` or `F11`, `Esc` to exit.
- **Quiet by design** — no settings panel, no toolbar, no theme switcher. Locked light palette, custom titlebar.

(More features land per the milestones in [SPEC.md](SPEC.md). M1 ships with first-page rendering only.)

## Keybindings (M1)

| Action          | Key            |
|-----------------|----------------|
| Open            | `Ctrl+O`       |
| Fullscreen      | `F` or `F11`   |
| Exit fullscreen | `Esc`          |
| Close window    | `Ctrl+W`       |
| Quit            | `Ctrl+Q`       |

## Run from CLI

```sh
krill-document-viewer path/to/paper.pdf
```

Without an arg, the app starts empty — drag-drop or `Ctrl+O` to load.

## Build from source

Requires Rust 1.77+, Node 20+, pnpm, and Tauri 2's Linux build deps.

```sh
pnpm install
pnpm tauri dev      # development with hot reload
pnpm tauri build    # release artifacts in src-tauri/target/release/bundle/
```

## Releasing

Bump the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` (all three must match), then:

```sh
pnpm release
```

This runs `tauri build` and gathers AppImage + .deb under `release/v<version>/` with SHA256 checksums. Tag and push to trigger the GitHub Release workflow.

## License

MIT.
