// Per-pixel SDR → HDR encoding pipeline.
//
// Why this exists: a pure ICC profile *assign* (keep bytes, change tag) burns
// colors. It reinterprets sRGB primaries as Rec.2020 (saturation balloons)
// and sRGB-gamma values as PQ (midtones get blown out). The output has glow
// but the skin reads red and the whites tint.
//
// So we actually convert. For each pixel:
//   1. sRGB EOTF       → linear-light sRGB
//   2. 3×3 matrix      → linear-light Rec.2020   (gamut fix)
//   3. scale by whiteNits / 10000                (where the "SDR white" lands)
//   4. PQ OETF         → PQ code value
//
// The output JPEG is then tagged Rec.2020 PQ (CICP primaries=9, transfer=16)
// — and now the tag *honestly describes* the pixel values, so HDR-aware OSes
// tone-map cleanly. Highlights still glow because we land SDR-equivalent
// "white" above 100 nits, pushing the brightest pixels into HDR headroom.

const SRGB_BREAK = 0.04045;

function srgbToLinear(v: number): number {
  return v <= SRGB_BREAK ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// BT.2087 / standard derivation, D65 → D65, linear light.
function srgbToRec2020(r: number, g: number, b: number): [number, number, number] {
  return [
    0.6274040 * r + 0.3292820 * g + 0.0433136 * b,
    0.0690970 * r + 0.9195400 * g + 0.0113612 * b,
    0.0163914 * r + 0.0880133 * g + 0.8955950 * b,
  ];
}

// PQ OETF: linear cd/m² (0..10000) → PQ code value (0..1). SMPTE ST 2084.
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

function pqOetf(nits: number): number {
  const E = Math.max(0, Math.min(1, nits / 10000));
  const Em1 = Math.pow(E, PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2 * Em1) / (1 + PQ_C3 * Em1), PQ_M2);
}

export interface EncodeOptions {
  // Where input value 1.0 (SDR diffuse white) lands in absolute nits.
  //   100  → looks like a normal SDR image on an HDR display (no glow)
  //   200  → mild glow on highlights
  //   500+ → strong glow, may clip on dimmer HDR displays
  whiteNits: number;
}

// Build the sRGB→linear LUT once. 256 entries, hot loop hits it every pixel.
const SRGB_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_LUT[i] = srgbToLinear(i / 255);

export function encodeImageDataToPQ(data: Uint8ClampedArray, opts: EncodeOptions): void {
  const scale = opts.whiteNits;
  for (let i = 0; i < data.length; i += 4) {
    const r = SRGB_LUT[data[i]];
    const g = SRGB_LUT[data[i + 1]];
    const b = SRGB_LUT[data[i + 2]];
    const R = 0.6274040 * r + 0.3292820 * g + 0.0433136 * b;
    const G = 0.0690970 * r + 0.9195400 * g + 0.0113612 * b;
    const B = 0.0163914 * r + 0.0880133 * g + 0.8955950 * b;
    // Inline pqOetf for speed — avoids 3 calls per pixel.
    const eR = (R * scale) / 10000;
    const eG = (G * scale) / 10000;
    const eB = (B * scale) / 10000;
    const m1R = Math.pow(Math.max(0, Math.min(1, eR)), PQ_M1);
    const m1G = Math.pow(Math.max(0, Math.min(1, eG)), PQ_M1);
    const m1B = Math.pow(Math.max(0, Math.min(1, eB)), PQ_M1);
    const pqR = Math.pow((PQ_C1 + PQ_C2 * m1R) / (1 + PQ_C3 * m1R), PQ_M2);
    const pqG = Math.pow((PQ_C1 + PQ_C2 * m1G) / (1 + PQ_C3 * m1G), PQ_M2);
    const pqB = Math.pow((PQ_C1 + PQ_C2 * m1B) / (1 + PQ_C3 * m1B), PQ_M2);
    data[i] = (pqR * 255 + 0.5) | 0;
    data[i + 1] = (pqG * 255 + 0.5) | 0;
    data[i + 2] = (pqB * 255 + 0.5) | 0;
    // alpha untouched
  }
  // Quiet unused exports — kept exported for callers/tests that want them.
  void srgbToRec2020;
  void pqOetf;
}

export { srgbToRec2020, pqOetf };
