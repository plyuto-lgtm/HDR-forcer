import "./style.css";
import { loadRec2020PQProfile } from "./iccProfile.ts";
import { injectIccProfile } from "./jpegInject.ts";
import { inspectJpeg } from "./inspect.ts";
import { encodeJpeg, type JpegFlavor } from "./jpegEncode.ts";

const MAX_DIM = 1400;

const drop = document.getElementById("drop") as HTMLElement;
const dropInner = document.getElementById("dropInner") as HTMLElement;
const chooseBtn = document.getElementById("chooseBtn") as HTMLButtonElement;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const workspace = document.getElementById("workspace") as HTMLElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const glow = document.getElementById("glow") as HTMLInputElement;
const glowOut = document.getElementById("glowOut") as HTMLOutputElement;
const downloadBtn = document.getElementById("downloadBtn") as HTMLButtonElement;
const resetBtn = document.getElementById("resetBtn") as HTMLButtonElement;
const inspectOut = document.getElementById("inspectOut") as HTMLPreElement;
const sizeSel = document.getElementById("size") as HTMLSelectElement;
const sizeOut = document.getElementById("sizeOut") as HTMLOutputElement;
const squareChk = document.getElementById("square") as HTMLInputElement;
const formatSel = document.getElementById("format") as HTMLSelectElement;
const formatOut = document.getElementById("formatOut") as HTMLOutputElement;

interface LoadedImage {
  img: HTMLImageElement;
  name: string;
}

let current: LoadedImage | null = null;

// A draw plan: which source rect to sample, and the output canvas size.
interface DrawPlan {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dw: number;
  dh: number;
}

// Selected target for the longest output side. 0 = "original" (cap at MAX_DIM).
function selectedTarget(): number {
  return parseInt(sizeSel.value, 10) || 0;
}

function planDraw(img: HTMLImageElement): DrawPlan {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;

  if (squareChk.checked) {
    // Center-crop the source to a square, then scale to target×target.
    const side = Math.min(nw, nh);
    const sx = Math.round((nw - side) / 2);
    const sy = Math.round((nh - side) / 2);
    // Target side (MAX_DIM for "original"); never upscale past the crop.
    const target = selectedTarget() || MAX_DIM;
    const out = Math.min(target, side);
    return { sx, sy, sw: side, sh: side, dw: out, dh: out };
  }

  // Fit the longest side to the target (or MAX_DIM); never upscale.
  const longest = Math.max(nw, nh);
  const target = selectedTarget() || MAX_DIM;
  const limit = Math.min(target, longest);
  const scale = limit / longest;
  return {
    sx: 0,
    sy: 0,
    sw: nw,
    sh: nh,
    dw: Math.round(nw * scale),
    dh: Math.round(nh * scale),
  };
}

function updateSizeReadout(): void {
  if (!current) {
    sizeOut.textContent = "—";
    return;
  }
  const p = planDraw(current.img);
  sizeOut.textContent = `${p.dw}×${p.dh}`;
}

function redraw(): void {
  if (!current) return;
  const p = planDraw(current.img);
  canvas.width = p.dw;
  canvas.height = p.dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, p.dw, p.dh);
  // Brightness scales the pixel values before export. Under the assigned PQ
  // profile those raised values are read as higher absolute luminance, which
  // is what drives glow intensity. The preview shows the same scaling so it
  // tracks the export (though glow itself only appears on an HDR display).
  ctx.filter = `brightness(${glow.value})`;
  ctx.drawImage(current.img, p.sx, p.sy, p.sw, p.sh, 0, 0, p.dw, p.dh);
  updateSizeReadout();
}

function sliderBrightness(): number {
  return parseFloat(glow.value);
}

function loadFile(file: File): void {
  if (!file.type.startsWith("image/")) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    current = { img, name: baseName(file.name) };
    workspace.hidden = false;
    drop.classList.add("compact");
    inspectOut.textContent = "Export to verify.";
    redraw();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    inspectOut.textContent = "Failed to decode that image.";
  };
  img.src = url;
}

function baseName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? filename : filename.slice(0, dot);
}

async function exportGlow(): Promise<void> {
  if (!current) return;
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Encoding…";
  try {
    const { img } = current;
    const p = planDraw(img);

    // Draw the source onto an offscreen canvas with the brightness scaling
    // baked in. We DON'T convert the pixels — the JPEG keeps its sRGB-encoded
    // values and we simply ASSIGN the Rec.2020 PQ profile, so HDR-aware OSes
    // reinterpret those values on the PQ curve. This matches how the known-good
    // reference avatars are built.
    const off = document.createElement("canvas");
    off.width = p.dw;
    off.height = p.dh;
    const offCtx = off.getContext("2d", { willReadFrequently: true });
    if (!offCtx) throw new Error("No 2D context for offscreen canvas");
    offCtx.filter = `brightness(${sliderBrightness()})`;
    offCtx.drawImage(img, p.sx, p.sy, p.sw, p.sh, 0, 0, p.dw, p.dh);
    const imageData = offCtx.getImageData(0, 0, p.dw, p.dh);

    // Encode with mozjpeg so we control baseline vs progressive (SOF0/SOF2).
    // canvas.toBlob can only ever produce baseline.
    const flavor = formatSel.value as JpegFlavor;
    const jpeg = await encodeJpeg(imageData, 95, flavor);
    const profile = await loadRec2020PQProfile();
    const tagged = injectIccProfile(jpeg, profile);

    const report = inspectJpeg(tagged);
    inspectOut.textContent = formatInspect(report);
    if (!report.isHdrTagged) {
      throw new Error("Inspector says the output is NOT HDR-tagged.");
    }

    triggerDownload(tagged, `${current.name}_glow.jpg`);
  } catch (err) {
    inspectOut.textContent =
      "Export failed: " + (err instanceof Error ? err.message : String(err));
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = "Download glowing JPEG";
  }
}

function triggerDownload(bytes: Uint8Array, filename: string): void {
  // Copy into a fresh ArrayBuffer so the Blob ctor accepts it without
  // SharedArrayBuffer ambiguity in strict typings.
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  const blob = new Blob([ab], { type: "image/jpeg" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick — Safari needs the URL to live through the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatInspect(r: ReturnType<typeof inspectJpeg>): string {
  if (!r.hasIccProfile) return "No ICC profile found in output (this is a bug).";
  const c = r.cicp;
  const sofMarker =
    r.sof === "progressive" ? "SOF2" : r.sof === "baseline" ? "SOF0" : "?";
  const lines = [
    `ICC profile embedded: ${r.profileBytes} bytes`,
    c
      ? `CICP — primaries=${c.colourPrimaries} (Rec.2020=9), transfer=${c.transferCharacteristics} (PQ=16), full-range=${c.videoFullRangeFlag}`
      : "CICP tag NOT FOUND in ICC profile.",
    `HDR-tagged: ${r.isHdrTagged ? "YES ✓" : "NO ✗"}`,
    `JPEG format: ${r.sof} (${sofMarker})`,
  ];
  return lines.join("\n");
}

// ---- Wiring ----

// Warm the ICC profile cache so the first export doesn't pay the fetch cost.
void loadRec2020PQProfile();

chooseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
});

glow.addEventListener("input", () => {
  glowOut.textContent = `${sliderBrightness().toFixed(2)}×`;
  redraw();
});

sizeSel.addEventListener("change", redraw);
squareChk.addEventListener("change", redraw);
formatSel.addEventListener("change", () => {
  formatOut.textContent = formatSel.value === "progressive" ? "SOF2" : "SOF0";
});

downloadBtn.addEventListener("click", () => {
  void exportGlow();
});

resetBtn.addEventListener("click", () => {
  current = null;
  workspace.hidden = true;
  drop.classList.remove("compact");
  fileInput.value = "";
  glow.value = "1.0";
  glowOut.textContent = "1.00×";
  sizeSel.value = "400";
  squareChk.checked = false;
  sizeOut.textContent = "—";
  formatSel.value = "progressive";
  formatOut.textContent = "SOF2";
  inspectOut.textContent = "Export to verify.";
});

// Drag & drop
function setDragState(active: boolean): void {
  dropInner.classList.toggle("dragging", active);
}
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    setDragState(true);
  }),
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    setDragState(false);
  }),
);
drop.addEventListener("drop", (e) => {
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) loadFile(f);
});
