import "@krill-software/desktop-ui/styles";
import "./styles.css";
import { mountChrome, buildEmptyState, buildErrorState, showBootError, type ErrorStateRefs } from "@krill-software/desktop-ui";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getMatches } from "@tauri-apps/plugin-cli";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import * as pdfjsLib from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

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

// ---- DOM refs (assigned in initChrome) -------------------------------

let titleEl: HTMLElement;
let infoEl: HTMLElement;     // status-info (file identity)
let stateEl: HTMLElement;    // status-state (page position)
let viewportEl: HTMLElement;
let pagesEl: HTMLElement;
let sidebarEl: HTMLElement;  // bound to chrome.aux
let emptyEl: HTMLElement;
let errorState: ErrorStateRefs;
let docByteSize = 0;

// ---- Doc state -------------------------------------------------------

interface DocState {
  doc: pdfjsLib.PDFDocumentProxy | null;
  path: string;
  pageNumber: number;
  totalPages: number;
}
const state: DocState = { doc: null, path: "", pageNumber: 1, totalPages: 0 };

let pageRows: HTMLElement[] = [];
const pageAspect = new Map<number, number>();
const rendered = new Set<number>();
const inFlight = new Map<number, pdfjsLib.RenderTask>();

// ---- Display state ---------------------------------------------------

type Display = "empty" | "document" | "error";
function setDisplay(s: Display) {
  document.body.dataset.state = s;
  emptyEl.hidden = s !== "empty";
  errorState.element.hidden = s !== "error";
  if (s !== "document") {
    titleEl.textContent = "";
    infoEl.replaceChildren();
    stateEl.replaceChildren();
    teardownDocument();
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

// ---- Page rendering (continuous scroll) ------------------------------

let renderObserver!: IntersectionObserver;

async function buildPages(doc: pdfjsLib.PDFDocumentProxy): Promise<void> {
  pagesEl.replaceChildren();
  pageRows = [];
  pageAspect.clear();
  rendered.clear();
  for (const t of inFlight.values()) { try { t.cancel(); } catch { /* ignore */ } }
  inFlight.clear();

  let defaultAspect = 8.5 / 11;
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
}

function teardownDocument() {
  for (const t of inFlight.values()) { try { t.cancel(); } catch { /* ignore */ } }
  inFlight.clear();
  for (const row of pageRows) renderObserver?.unobserve(row);
  pageRows = [];
  rendered.clear();
  pageAspect.clear();
  pagesEl?.replaceChildren();
}

function targetCssWidth(): number {
  return Math.max(160, viewportEl.clientWidth - 32);
}

function sizeRowToViewport(row: HTMLElement) {
  row.style.width = `${targetCssWidth()}px`;
}

async function renderPage(n: number): Promise<void> {
  if (!state.doc) return;
  const row = pageRows[n - 1];
  if (!row) return;

  rendered.add(n);

  let page: pdfjsLib.PDFPageProxy;
  try {
    page = await state.doc.getPage(n);
  } catch {
    rendered.delete(n);
    return;
  }
  if (!state.doc) { rendered.delete(n); return; }

  const baseViewport = page.getViewport({ scale: 1 });
  const aspect = baseViewport.width / baseViewport.height;
  if (pageAspect.get(n) !== aspect) {
    pageAspect.set(n, aspect);
    row.style.aspectRatio = `${aspect}`;
  }

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

function rerenderAll() {
  for (const row of pageRows) sizeRowToViewport(row);
  const toRerender = Array.from(rendered);
  rendered.clear();
  for (const n of toRerender) void renderPage(n);
}

// ---- Active-page tracking -------------------------------------------

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
    stateEl.textContent = `${bestN} / ${state.totalPages}`;
  }
}

// ---- Sidebar (thumbnails) -------------------------------------------

// 260px aux pane minus 16px padding minus 12px thumb-row inner padding.
const THUMB_CSS_WIDTH = 220;

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
    btn.addEventListener("click", () => goToPage(i));
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

// ---- Navigation -----------------------------------------------------

function goToPage(n: number): void {
  if (!state.doc) return;
  if (n < 1 || n > state.totalPages) return;
  const row = pageRows[n - 1];
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- Aux pane visibility (driven by body[data-aux]) -----------------

function isAuxVisible(): boolean {
  return document.body.dataset.aux === "visible";
}

function applyAuxVisibility(visible: boolean) {
  document.body.dataset.aux = visible ? "visible" : "hidden";
  requestAnimationFrame(() => rerenderAll());
}

async function toggleSidebar(): Promise<void> {
  applyAuxVisibility(!isAuxVisible());
  try {
    const current = (await invoke<AppState | null>("load_state")) ?? {};
    current.panel_visible = isAuxVisible();
    await invoke("save_state", { state: current });
  } catch (e) {
    console.warn("save_state failed:", e);
  }
}

// ---- Title / load --------------------------------------------------

function updateTitleBar(name: string) {
  titleEl.textContent = name;
  // Status line halves: identity (left), position (right).
  infoEl.textContent = `PDF · ${formatBytes(docByteSize)} · ${state.totalPages} ${state.totalPages === 1 ? "page" : "pages"}`;
  stateEl.textContent = `${state.pageNumber} / ${state.totalPages}`;
  stateEl.classList.add("mono");
  const title = `${name} — Document Viewer`;
  document.title = title;
  getCurrentWindow().setTitle(title).catch(() => {});
}

function showError(path: string) {
  errorState.setFilename(basename(path));
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
  docByteSize = bytes.byteLength;

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

// ---- Menus ---------------------------------------------------------

// Canonical actions are passed inline to mountChrome via the `actions` map.
// The package owns the labels, shortcuts, and menu placement.

async function toggleFullscreen(): Promise<void> {
  const w = getCurrentWindow();
  const isFs = await w.isFullscreen().catch(() => false);
  await w.setFullscreen(!isFs).catch(() => {});
  document.body.dataset.fullscreen = isFs ? "false" : "true";
  requestAnimationFrame(() => rerenderAll());
}

// Esc out of fullscreen — the only app-specific keybinding the package
// can't cover via the action registry.
function installFullscreenEscape() {
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.dataset.fullscreen === "true") {
      e.preventDefault();
      void toggleFullscreen();
    }
  }, { capture: true });
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

// ---- Init / boot ---------------------------------------------------

function initChrome() {
  const chrome = mountChrome({
    productName: "Document Viewer",
    actions: {
      "open":           openViaDialog,
      "fullscreen":     toggleFullscreen,
      "toggle-sidebar": toggleSidebar,
      "previous":       () => goToPage(state.pageNumber - 1),
      "next":           () => goToPage(state.pageNumber + 1),
      "first":          () => goToPage(1),
      "last":           () => goToPage(state.totalPages),
    },
    bindings: {
      "PageUp":   () => goToPage(state.pageNumber - 1),
      "PageDown": () => goToPage(state.pageNumber + 1),
    },
    showAuxPane: true,
    showStatusLine: true,
    updater: true,
  });
  titleEl = chrome.title;
  viewportEl = chrome.viewport;
  sidebarEl = chrome.aux!;
  sidebarEl.setAttribute("aria-label", "Pages");
  infoEl = chrome.statusInfo!;
  stateEl = chrome.statusState!;

  // Pages container + empty / error placeholders inside the viewport.
  pagesEl = document.createElement("div");
  pagesEl.id = "pages";
  viewportEl.appendChild(pagesEl);

  emptyEl = buildEmptyState();
  viewportEl.appendChild(emptyEl);

  errorState = buildErrorState({ message: "Couldn't open this PDF." });
  errorState.element.hidden = true;
  viewportEl.appendChild(errorState.element);

  // The IntersectionObserver for lazy page rendering needs viewportEl as its
  // root. We set it up here once viewportEl is known.
  renderObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const row = entry.target as HTMLElement;
      const n = parseInt(row.dataset.page!, 10);
      if (!rendered.has(n)) void renderPage(n);
    }
  }, { root: viewportEl, rootMargin: "600px" });

  viewportEl.addEventListener("scroll", () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      recomputeActivePage();
    });
  }, { passive: true });

  document.body.dataset.state = "empty";
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
  initChrome();
  installFullscreenEscape();
  await installFileDrop();

  try {
    const saved = await invoke<AppState | null>("load_state");
    applyAuxVisibility(saved?.panel_visible ?? true);
  } catch {
    applyAuxVisibility(true);
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

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(e);
});
