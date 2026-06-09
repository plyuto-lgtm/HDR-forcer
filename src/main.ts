import "./style.css";
import { loadRec2020PQProfile } from "./iccProfile.ts";
import { injectIccProfile } from "./jpegInject.ts";
import { inspectJpeg, inspectUltraHdr } from "./inspect.ts";
import { encodeJpeg, type JpegFlavor } from "./jpegEncode.ts";
import { encodeImageDataToPQ } from "./encode.ts";
import { buildGainMap } from "./gainMap.ts";
import { assembleUltraHdr } from "./ultraHdr.ts";

const MAX_DIM = 1400;

const drop = document.getElementById("drop") as HTMLElement;
const dropInner = document.getElementById("dropInner") as HTMLElement;
const chooseBtn = document.getElementById("chooseBtn") as HTMLButtonElement;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const workspace = document.getElementById("workspace") as HTMLElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const glow = document.getElementById("glow") as HTMLInputElement;
const glowOut = document.getElementById("glowOut") as HTMLOutputElement;
const glowLabel = document.getElementById("glowLabel") as HTMLLabelElement;
const modeSel = document.getElementById("mode") as HTMLSelectElement;
const modeOut = document.getElementById("modeOut") as HTMLOutputElement;
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
  // In assign mode the slider scales pixel values (brightness) and the preview
  // reflects that. In convert mode the slider is a target-nits value that only
  // affects the encoded export, so we show the image unscaled.
  ctx.filter =
    mode() === "assign" || mode() === "combined" ? `brightness(${glow.value})` : "none";
  ctx.drawImage(current.img, p.sx, p.sy, p.sw, p.sh, 0, 0, p.dw, p.dh);
  updateSizeReadout();
}

type Mode = "assign" | "convert" | "gainmap" | "combined";

function mode(): Mode {
  if (modeSel.value === "convert") return "convert";
  if (modeSel.value === "gainmap") return "gainmap";
  if (modeSel.value === "combined") return "combined";
  return "assign";
}

function sliderBrightness(): number {
  return parseFloat(glow.value);
}

function sliderToNits(): number {
  // Convert-mode slider 1.0..6.0 → 100..600 nits "diffuse white" target.
  return Math.round(parseFloat(glow.value) * 100);
}

function sliderBoost(): number {
  // Gain-map slider 2.0..8.0 → max highlight boost multiplier.
  return parseFloat(glow.value);
}

// Swap the Glow slider's range/label to match the active mode, then redraw.
function applyMode(): void {
  modeOut.textContent = mode();
  if (mode() === "assign" || mode() === "combined") {
    // Combined uses an Assign-style PQ base, so it shares the brightness knob.
    glowLabel.textContent = "Glow";
    glow.min = "0.5";
    glow.max = "1.6";
    glow.step = "0.01";
    glow.value = "1.0";
  } else if (mode() === "convert") {
    glowLabel.textContent = "White";
    glow.min = "1.0";
    glow.max = "6.0";
    glow.step = "0.1";
    glow.value = "2.0";
  } else {
    glowLabel.textContent = "Boost";
    glow.min = "2.0";
    glow.max = "8.0";
    glow.step = "0.1";
    glow.value = "4.0";
  }
  glowOut.textContent = glowReadout();
  redraw();
}

function glowReadout(): string {
  if (mode() === "assign" || mode() === "combined") return `${sliderBrightness().toFixed(2)}×`;
  if (mode() === "convert") return `${sliderToNits()} nits`;
  return `${sliderBoost().toFixed(1)}× boost`;
}

function isHeic(file: File): boolean {
  const t = file.type.toLowerCase();
  const n = file.name.toLowerCase();
  // Browsers often report an empty type for HEIC, so fall back to extension.
  return (
    t === "image/heic" ||
    t === "image/heif" ||
    t === "image/heic-sequence" ||
    t === "image/heif-sequence" ||
    n.endsWith(".heic") ||
    n.endsWith(".heif")
  );
}

function loadImageFromBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    current = { img, name: baseName(name) };
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

async function loadFile(file: File): Promise<void> {
  // Chrome/Firefox can't decode HEIC natively — decode it to a JPEG blob first
  // (lazy-loaded so the ~1MB decoder only ships when someone drops a HEIC).
  if (isHeic(file)) {
    inspectOut.textContent = "Decoding HEIC…";
    try {
      const heic2any = (await import("heic2any")).default;
      const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.95 });
      const jpeg = Array.isArray(out) ? out[0] : out;
      loadImageFromBlob(jpeg, file.name);
    } catch (err) {
      inspectOut.textContent =
        "HEIC decode failed: " + (err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (!file.type.startsWith("image/")) return;
  loadImageFromBlob(file, file.name);
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

    const off = document.createElement("canvas");
    off.width = p.dw;
    off.height = p.dh;
    const offCtx = off.getContext("2d", { willReadFrequently: true });
    if (!offCtx) throw new Error("No 2D context for offscreen canvas");

    if (mode() === "assign" || mode() === "combined") {
      // ASSIGN / COMBINED: keep the sRGB-encoded pixel values (brightness baked
      // in). Assign just tags Rec.2020 PQ; combined also appends a gain map.
      offCtx.filter = `brightness(${sliderBrightness()})`;
      offCtx.drawImage(img, p.sx, p.sy, p.sw, p.sh, 0, 0, p.dw, p.dh);
    } else {
      // CONVERT and GAINMAP both start from the unscaled SDR image.
      offCtx.drawImage(img, p.sx, p.sy, p.sw, p.sh, 0, 0, p.dw, p.dh);
    }
    const imageData = offCtx.getImageData(0, 0, p.dw, p.dh);
    const flavor = formatSel.value as JpegFlavor;

    if (mode() === "combined") {
      // COMBINED (experimental): the base is the Assign PQ image (survives
      // LinkedIn, glows in Chrome via CICP). We ALSO append a gain map flagged
      // BaseRenditionIsHDR=True — the gain map describes the SDR fallback of an
      // HDR base, and its presence may flip iOS into honoring the PQ base.
      const { gain, meta } = buildGainMap(imageData, {
        boostMax: 4,
        loThreshold: 0.5,
        hiThreshold: 1.0,
        baseIsHdr: true,
      });
      const baseJpeg = await encodeJpeg(imageData, 95, flavor);
      const profile = await loadRec2020PQProfile();
      const baseTagged = injectIccProfile(baseJpeg, profile);
      const gainJpeg = await encodeJpeg(gain, 90, flavor);
      const ultra = assembleUltraHdr(baseTagged, gainJpeg, meta);
      const pq = inspectJpeg(ultra);
      inspectOut.textContent =
        formatGainMapInspect(ultra, meta) +
        `\nPQ base tag: ${pq.isHdrTagged ? "YES ✓ (primaries=9, transfer=16)" : "NO ✗"}` +
        `\nBaseRenditionIsHDR: True`;
      triggerDownload(ultra, `${current.name}_combined.jpg`);
      return;
    }

    if (mode() === "gainmap") {
      // GAIN MAP (UltraHDR): the SDR image is the base; we synthesize a
      // grayscale gain map from its highlights and pack both into one file
      // with MPF + hdrgm XMP. This is the format iOS Photos / Safari render.
      const { gain, meta } = buildGainMap(imageData, {
        boostMax: sliderBoost(),
        loThreshold: 0.5,
        hiThreshold: 1.0,
      });
      const baseJpeg = await encodeJpeg(imageData, 95, flavor);
      const gainJpeg = await encodeJpeg(gain, 90, flavor);
      const ultra = assembleUltraHdr(baseJpeg, gainJpeg, meta);
      inspectOut.textContent = formatGainMapInspect(ultra, meta);
      triggerDownload(ultra, `${current.name}_gainmap.jpg`);
      return;
    }

    if (mode() === "convert") {
      encodeImageDataToPQ(imageData.data, { whiteNits: sliderToNits() });
    }

    // Encode with mozjpeg so we control baseline vs progressive (SOF0/SOF2).
    // canvas.toBlob can only ever produce baseline.
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

function formatGainMapInspect(
  bytes: Uint8Array,
  meta: { gainMapMax: number },
): string {
  const r = inspectUltraHdr(bytes);
  const lines = [
    `UltraHDR file: ${bytes.length} bytes`,
    `Primary XMP hdrgm:Version: ${r.hasXmpVersion ? "YES ✓" : "NO ✗"}`,
    `GContainer GainMap item: ${r.hasGainMapSemantic ? "YES ✓" : "NO ✗"}`,
    `MPF images: ${r.mpfImageCount} (expect 2)`,
    `Gain-map second image: ${r.secondImageIsJpeg ? `YES ✓ @${r.secondImageOffset}` : "NO ✗"}`,
    `GainMapMax: ${(r.gainMapMax ?? meta.gainMapMax).toFixed(3)} (log2, = ${Math.pow(2, r.gainMapMax ?? meta.gainMapMax).toFixed(1)}× boost)`,
    `Valid UltraHDR: ${r.isValid ? "YES ✓" : "NO ✗"}`,
  ];
  if (!r.isValid) lines.push("⚠ Gain-map structure invalid — this is a bug.");
  return lines.join("\n");
}

// ---- Wiring ----

// Warm the ICC profile cache so the first export doesn't pay the fetch cost.
void loadRec2020PQProfile();

chooseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) void loadFile(f);
});

glow.addEventListener("input", () => {
  glowOut.textContent = glowReadout();
  redraw();
});

modeSel.addEventListener("change", applyMode);
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
  modeSel.value = "assign";
  applyMode();
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
  if (f) void loadFile(f);
});
