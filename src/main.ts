import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getMatches } from "@tauri-apps/plugin-cli";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import * as pdfjsLib from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

import { installMenuBar, type MenuDef } from "./menu";

interface DocumentRead {
  path: string;
  bytes: number[] | Uint8Array;
  mime: string;
}

interface AppState {
  window?: { width: number; height: number; x: number; y: number };
  recent?: string[];
  panel_visible?: boolean;
}

const pagesEl = document.getElementById("pages") as HTMLElement;
const viewportEl = document.getElementById("viewport") as HTMLElement;
const sidebarEl = document.getElementById("sidebar")!;
const titleEl = document.getElementById("titlebar-title")!;
const positionEl = document.getElementById("status-position")!;
const errorName = document.getElementById("error-name")!;

interface DocState {
  doc: pdfjsLib.PDFDocumentProxy | null;
  path: string;
  pageNumber: number;     // currently most-visible page
  totalPages: number;
}
const state: DocState = { doc: null, path: "", pageNumber: 1, totalPages: 0 };

// pageRows[i] is the .page-row element for page (i+1).
let pageRows: HTMLElement[] = [];
// Aspect ratio (width/height) per page; populated on first render of each page.
const pageAspect = new Map<number, number>();
// Pages whose canvas has been rendered.
const rendered = new Set<number>();
// In-flight render tasks per page, so we can cancel them on resize.
const inFlight = new Map<number, pdfjsLib.RenderTask>();

// ---- Display state -----------------------------------------------------

type Display = "empty" | "document" | "error";
function setDisplay(s: Display) {
  document.body.dataset.state = s;
  if (s !== "document") {
    titleEl.textContent = "";
    positionEl.textContent = "";
    teardownDocument();
  }
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

// ---- Continuous-scroll page rendering --------------------------------

const renderObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const row = entry.target as HTMLElement;
    const n = parseInt(row.dataset.page!, 10);
    if (!rendered.has(n)) void renderPage(n);
  }
}, { root: null /* viewport scroll root applied below */, rootMargin: "600px" });

async function buildPages(doc: pdfjsLib.PDFDocumentProxy): Promise<void> {
  pagesEl.replaceChildren();
  pageRows = [];
  pageAspect.clear();
  rendered.clear();
  for (const t of inFlight.values()) { try { t.cancel(); } catch { /* ignore */ } }
  inFlight.clear();

  // Pre-fetch page 1's metadata to get a default aspect ratio for layout.
  let defaultAspect = 8.5 / 11; // letter, fallback
  try {
    const p1 = await doc.getPage(1);
    const v = p1.getViewport({ scale: 1 });
    defaultAspect = v.width / v.height;
    pageAspect.set(1, defaultAspect);
  } catch { /* keep default */ }

  for (let i = 1; i <= doc.numPages; i++) {
    const row = document.createElement("div");
    row.className = "page-row";
    row.dataset.page = String(i);
    row.style.aspectRatio = `${pageAspect.get(i) ?? defaultAspect}`;
    sizeRowToViewport(row);
    pagesEl.appendChild(row);
    pageRows.push(row);
    renderObserver.observe(row);
  }

  // Initial render pass + active-page resolve happen as IntersectionObserver fires.
}

function teardownDocument() {
  for (const t of inFlight.values()) { try { t.cancel(); } catch { /* ignore */ } }
  inFlight.clear();
  for (const row of pageRows) renderObserver.unobserve(row);
  pageRows = [];
  rendered.clear();
  pageAspect.clear();
  pagesEl.replaceChildren();
}

/** Compute the on-screen CSS width for a page-row given current viewport size. */
function targetCssWidth(): number {
  // Viewport content area minus left+right padding (16px each).
  return Math.max(160, viewportEl.clientWidth - 32);
}

function sizeRowToViewport(row: HTMLElement) {
  const w = targetCssWidth();
  row.style.width = `${w}px`;
}

async function renderPage(n: number): Promise<void> {
  if (!state.doc) return;
  const row = pageRows[n - 1];
  if (!row) return;

  rendered.add(n); // claim ownership early so we don't double-render

  let page: pdfjsLib.PDFPageProxy;
  try {
    page = await state.doc.getPage(n);
  } catch {
    rendered.delete(n);
    return;
  }
  if (!state.doc) { rendered.delete(n); return; }

  // Update the row's aspect ratio if this is the first time we've seen the page.
  const baseViewport = page.getViewport({ scale: 1 });
  const aspect = baseViewport.width / baseViewport.height;
  if (pageAspect.get(n) !== aspect) {
    pageAspect.set(n, aspect);
    row.style.aspectRatio = `${aspect}`;
  }

  // Two viewports: one in CSS units (for text layer + canvas display), and one
  // dpr-scaled (for the canvas's internal pixel buffer).
  const dpr = window.devicePixelRatio || 1;
  const cssW = row.clientWidth || targetCssWidth();
  const cssH = cssW / aspect;
  const cssScale = cssW / baseViewport.width;
  const cssViewport = page.getViewport({ scale: cssScale });
  const renderViewport = page.getViewport({ scale: cssScale * dpr });

  let canvas = row.querySelector("canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement("canvas");
    row.appendChild(canvas);
  }
  canvas.width = Math.floor(renderViewport.width);
  canvas.height = Math.floor(renderViewport.height);
  canvas.style.width = `${Math.floor(cssW)}px`;
  canvas.style.height = `${Math.floor(cssH)}px`;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;

  const prior = inFlight.get(n);
  if (prior) { try { prior.cancel(); } catch { /* ignore */ } }

  const task = page.render({ canvasContext: ctx, viewport: renderViewport });
  inFlight.set(n, task);
  try {
    await task.promise;
  } catch (e: any) {
    if (e?.name !== "RenderingCancelledException") {
      console.warn(`page ${n} render failed:`, e);
      rendered.delete(n);
    }
    return;
  } finally {
    if (inFlight.get(n) === task) inFlight.delete(n);
  }

  // Text layer (transparent, positioned spans for native selection / copy).
  await renderTextLayer(page, row, cssViewport);
}

async function renderTextLayer(
  page: pdfjsLib.PDFPageProxy,
  row: HTMLElement,
  viewport: pdfjsLib.PageViewport,
): Promise<void> {
  let layerEl = row.querySelector(".textLayer") as HTMLElement | null;
  if (!layerEl) {
    layerEl = document.createElement("div");
    layerEl.className = "textLayer";
    row.appendChild(layerEl);
  } else {
    layerEl.replaceChildren();
  }
  layerEl.style.width = `${Math.floor(viewport.width)}px`;
  layerEl.style.height = `${Math.floor(viewport.height)}px`;
  layerEl.style.setProperty("--scale-factor", String(viewport.scale));

  try {
    const textContent = await page.getTextContent();
    const layer = new TextLayer({
      textContentSource: textContent,
      container: layerEl,
      viewport,
    });
    await layer.render();
  } catch (e: any) {
    if (e?.name !== "RenderingCancelledException") {
      console.warn(`text layer ${row.dataset.page} failed:`, e);
    }
  }
}

/** Re-render every page that's currently rendered, at the new fit-width. */
function rerenderAll() {
  for (const row of pageRows) sizeRowToViewport(row);
  // Keep the rendered set; just kick a re-render for each.
  const toRerender = Array.from(rendered);
  rendered.clear();
  for (const n of toRerender) void renderPage(n);
}

// ---- Active-page tracking via scroll ---------------------------------

let scrollRaf = 0;

function recomputeActivePage() {
  if (pageRows.length === 0) return;
  const vr = viewportEl.getBoundingClientRect();
  let bestN = state.pageNumber;
  let bestArea = -1;
  for (const row of pageRows) {
    const r = row.getBoundingClientRect();
    const visTop = Math.max(r.top, vr.top);
    const visBot = Math.min(r.bottom, vr.bottom);
    const visArea = Math.max(0, visBot - visTop);
    if (visArea > bestArea) {
      bestArea = visArea;
      bestN = parseInt(row.dataset.page!, 10);
    }
  }
  if (bestN !== state.pageNumber) {
    state.pageNumber = bestN;
    setSidebarActive(bestN);
    positionEl.textContent = `${bestN} / ${state.totalPages}`;
  }
}

viewportEl.addEventListener("scroll", () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    recomputeActivePage();
  });
}, { passive: true });

// ---- Sidebar (page thumbnails) ----------------------------------------

const THUMB_CSS_WIDTH = 110;

const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target as HTMLElement;
    if (el.dataset.rendered === "false") {
      const n = parseInt(el.dataset.page!, 10);
      void renderThumb(n, el);
    }
  }
}, { root: null, rootMargin: "240px" });

function clearSidebar() {
  for (const el of sidebarEl.querySelectorAll(".thumb")) thumbObserver.unobserve(el);
  sidebarEl.replaceChildren();
}

function buildSidebar() {
  clearSidebar();
  for (let i = 1; i <= state.totalPages; i++) {
    const btn = document.createElement("button");
    btn.className = "thumb";
    btn.dataset.page = String(i);
    btn.dataset.rendered = "false";
    btn.type = "button";
    btn.innerHTML = `
      <div class="thumb-canvas-holder"><canvas class="thumb-canvas"></canvas></div>
      <div class="thumb-label">${i}</div>
    `;
    btn.addEventListener("click", () => void goToPage(i));
    sidebarEl.appendChild(btn);
    thumbObserver.observe(btn);
  }
  setSidebarActive(state.pageNumber);
}

async function renderThumb(n: number, el: HTMLElement): Promise<void> {
  if (!state.doc) return;
  el.dataset.rendered = "pending";
  let page;
  try { page = await state.doc.getPage(n); }
  catch { el.dataset.rendered = "false"; return; }
  if (!state.doc) { el.dataset.rendered = "false"; return; }

  const c = el.querySelector("canvas") as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const baseViewport = page.getViewport({ scale: 1 });
  const cssScale = THUMB_CSS_WIDTH / baseViewport.width;
  const v = page.getViewport({ scale: cssScale * dpr });

  c.width = Math.floor(v.width);
  c.height = Math.floor(v.height);
  c.style.width = `${Math.floor(v.width / dpr)}px`;
  c.style.height = `${Math.floor(v.height / dpr)}px`;

  const ctx = c.getContext("2d", { alpha: false });
  if (!ctx) return;
  try {
    await page.render({ canvasContext: ctx, viewport: v }).promise;
    el.dataset.rendered = "true";
  } catch (e: any) {
    if (e?.name !== "RenderingCancelledException") {
      console.warn(`thumb ${n} render failed:`, e);
    }
    el.dataset.rendered = "false";
  }
}

function setSidebarActive(n: number) {
  for (const el of sidebarEl.querySelectorAll(".thumb[data-active='true']")) {
    el.removeAttribute("data-active");
  }
  const active = sidebarEl.querySelector(`.thumb[data-page="${n}"]`) as HTMLElement | null;
  if (active) {
    active.dataset.active = "true";
    active.scrollIntoView({ block: "nearest" });
  }
}

// ---- Navigation -------------------------------------------------------

function goToPage(n: number): void {
  if (!state.doc) return;
  if (n < 1 || n > state.totalPages) return;
  const row = pageRows[n - 1];
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "start" });
  // recomputeActivePage will fire on the resulting scroll event.
}

// ---- Sidebar visibility ----------------------------------------------

let sidebarVisible = true;

function applySidebarVisibility(visible: boolean) {
  sidebarVisible = visible;
  document.body.dataset.sidebar = visible ? "visible" : "hidden";
  // Layout changed — re-render every page at the new fit-width on next frame.
  requestAnimationFrame(() => rerenderAll());
}

async function toggleSidebar(): Promise<void> {
  applySidebarVisibility(!sidebarVisible);
  try {
    const current = (await invoke<AppState | null>("load_state")) ?? {};
    current.panel_visible = sidebarVisible;
    await invoke("save_state", { state: current });
  } catch (e) {
    console.warn("save_state failed:", e);
  }
}

// ---- Title bar / window controls --------------------------------------

function updateTitleBar(name: string) {
  titleEl.textContent = name;
  positionEl.textContent = `${state.pageNumber} / ${state.totalPages}`;
  const title = `${name} — Document Viewer`;
  document.title = title;
  getCurrentWindow().setTitle(title).catch(() => {});
}

function showError(path: string) {
  errorName.textContent = basename(path);
  setDisplay("error");
}

async function openPath(path: string): Promise<void> {
  let res: DocumentRead;
  try {
    res = await invoke<DocumentRead>("read_document", { path });
  } catch (e) {
    console.error("read_document failed:", e);
    showError(path);
    return;
  }

  const bytes = res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes);

  if (state.doc) {
    try { await state.doc.destroy(); } catch { /* ignore */ }
    state.doc = null;
  }
  teardownDocument();
  clearSidebar();

  let doc: pdfjsLib.PDFDocumentProxy;
  try {
    doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (e) {
    console.error("pdf.js getDocument failed:", e);
    showError(res.path);
    return;
  }

  state.doc = doc;
  state.path = res.path;
  state.pageNumber = 1;
  state.totalPages = doc.numPages;

  setDisplay("document");
  updateTitleBar(basename(res.path));
  await buildPages(doc);
  buildSidebar();
  // Scroll to the top so we start on page 1.
  viewportEl.scrollTop = 0;
}

async function openViaDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (typeof selected === "string") await openPath(selected);
}

function buildMenus(): MenuDef[] {
  return [
    {
      label: "File",
      items: [
        { label: "Open…", shortcut: "Ctrl+O", action: () => void openViaDialog() },
        { sep: true },
        { label: "Close window", shortcut: "Ctrl+W", action: () => void getCurrentWindow().close() },
        { label: "Quit",         shortcut: "Ctrl+Q", action: () => void getCurrentWindow().close() },
      ],
    },
    {
      label: "View",
      items: [
        { label: "Toggle thumbnails", shortcut: "Ctrl+\\", action: () => void toggleSidebar() },
        { sep: true },
        { label: "Fullscreen", shortcut: "F", action: () => void toggleFullscreen() },
      ],
    },
    {
      label: "Go",
      items: [
        { label: "Previous page", shortcut: "←",     action: () => goToPage(state.pageNumber - 1) },
        { label: "Next page",     shortcut: "→",     action: () => goToPage(state.pageNumber + 1) },
        { sep: true },
        { label: "First page",    shortcut: "Home",  action: () => goToPage(1) },
        { label: "Last page",     shortcut: "End",   action: () => goToPage(state.totalPages) },
      ],
    },
  ];
}

async function toggleFullscreen(): Promise<void> {
  const w = getCurrentWindow();
  const isFs = await w.isFullscreen().catch(() => false);
  await w.setFullscreen(!isFs).catch(() => {});
  document.body.dataset.fullscreen = isFs ? "false" : "true";
  requestAnimationFrame(() => rerenderAll());
}

function installTitlebar() {
  const w = getCurrentWindow();
  const bind = (id: string, h: () => void | Promise<void>) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", (e) => { e.preventDefault(); void h(); });
  };
  bind("titlebar-min", () => w.minimize());
  bind("titlebar-max", async () => (await w.isMaximized()) ? w.unmaximize() : w.maximize());
  bind("titlebar-close", () => w.close());
  document.getElementById("titlebar-drag")?.addEventListener("dblclick", async () =>
    (await w.isMaximized()) ? w.unmaximize() : w.maximize(),
  );
}

function installKeybindings() {
  window.addEventListener("keydown", (e) => {
    if (isTextTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); void openViaDialog(); }
    else if (mod && (e.key.toLowerCase() === "q" || e.key.toLowerCase() === "w")) {
      e.preventDefault(); void getCurrentWindow().close();
    }
    else if (mod && e.key === "\\") { e.preventDefault(); void toggleSidebar(); }
    else if (!mod && (e.key === "f" || e.key === "F" || e.key === "F11")) {
      e.preventDefault(); void toggleFullscreen();
    }
    else if (!mod && e.key === "Escape" && document.body.dataset.fullscreen === "true") {
      e.preventDefault(); void toggleFullscreen();
    }
    else if (!mod && (e.key === "ArrowLeft"  || e.key === "PageUp"))   { e.preventDefault(); goToPage(state.pageNumber - 1); }
    else if (!mod && (e.key === "ArrowRight" || e.key === "PageDown")) { e.preventDefault(); goToPage(state.pageNumber + 1); }
    else if (!mod && e.key === "Home") { e.preventDefault(); goToPage(1); }
    else if (!mod && e.key === "End")  { e.preventDefault(); goToPage(state.totalPages); }
  }, { capture: true });
}

function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
}

async function installFileDrop() {
  const wv = getCurrentWebview();
  await wv.onDragDropEvent(async (e) => {
    if (e.payload.type === "drop") {
      const path = e.payload.paths[0];
      if (path) await openPath(path);
    }
  });
}

let resizeRaf = 0;
window.addEventListener("resize", () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if (state.doc) rerenderAll();
  });
});

async function boot() {
  installTitlebar();
  const menuContainer = document.getElementById("menu-bar");
  if (menuContainer) installMenuBar(menuContainer, buildMenus());
  installKeybindings();
  await installFileDrop();

  try {
    const saved = await invoke<AppState | null>("load_state");
    applySidebarVisibility(saved?.panel_visible ?? true);
  } catch {
    applySidebarVisibility(true);
  }

  let opened = false;
  try {
    const matches = await getMatches();
    const arg = matches.args.file?.value;
    if (typeof arg === "string" && arg.length > 0) {
      await openPath(arg);
      opened = true;
    }
  } catch { /* cli plugin unavailable */ }

  if (!opened && import.meta.env.DEV) {
    try {
      const dev = await invoke<string | null>("dev_test_file");
      if (dev) await openPath(dev);
    } catch { /* no test file */ }
  }
}

boot().catch((e) => console.error("boot failed:", e));
