// Synthesize a gain map from an SDR image.
//
// A gain map is the Apple/Android/Adobe-native way to do HDR stills: a normal
// SDR base image plus a grayscale "boost" image that tells HDR-aware viewers
// how much brighter to render each pixel, scaled to the display's headroom.
// Unlike a raw PQ tag (which Chrome honors but Apple's still pipeline ignores
// for 8-bit JPEG), a gain map is the format iOS Photos / Safari render.
//
// We don't have a real HDR source — we INVENT one: brighter SDR pixels get a
// bigger boost, so highlights bloom while shadows/midtones stay put. The
// `boostMax` knob is the glow intensity.
//
// Encoding (Android UltraHDR / Adobe hdrgm math, with GainMapMin=0, gamma=1):
//   gain(Y)    = 1 + (boostMax - 1) * smoothstep(loT, hiT, Y)   // >=1
//   recovery   = log2(gain) / log2(boostMax)                    // 0..1
//   gray8      = round(recovery * 255)
// The decoder inverts this: HDR = SDR * 2^(log2(boostMax) * recovery * weight)
// where weight ramps with the display's available headroom.

export interface GainMapMeta {
  gainMapMax: number; // log2(boostMax) — required hdrgm:GainMapMax
  gainMapMin: number; // log2(boostMin) = 0
  gamma: number; // 1.0
  offsetSdr: number; // 1/64
  offsetHdr: number; // 1/64
  hdrCapacityMin: number; // 0
  hdrCapacityMax: number; // log2(boostMax)
}

export interface GainMapResult {
  gain: ImageData; // grayscale (R=G=B) boost map, same size as base
  meta: GainMapMeta;
}

function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// sRGB EOTF (gamma → linear) for luminance computation.
function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export interface GainMapOptions {
  boostMax: number; // e.g. 4 → highlights up to 4x on a headroom-capable display
  loThreshold: number; // luminance where boost starts ramping (0..1), e.g. 0.5
  hiThreshold: number; // luminance where boost reaches max (0..1), e.g. 1.0
}

export function buildGainMap(base: ImageData, opts: GainMapOptions): GainMapResult {
  const { boostMax, loThreshold, hiThreshold } = opts;
  const log2Max = Math.log2(boostMax);
  const src = base.data;
  const out = new Uint8ClampedArray(src.length);

  for (let i = 0; i < src.length; i += 4) {
    // Linear-light luminance (Rec.709 weights on linearized sRGB).
    const r = srgbToLinear(src[i] / 255);
    const g = srgbToLinear(src[i + 1] / 255);
    const b = srgbToLinear(src[i + 2] / 255);
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    const gain = 1 + (boostMax - 1) * smoothstep(loThreshold, hiThreshold, y);
    // log2(gain) / log2(boostMax), clamped to 0..1, gamma=1 so no extra pow.
    const recovery = log2Max > 0 ? Math.min(1, Math.max(0, Math.log2(gain) / log2Max)) : 0;
    const gray = (recovery * 255 + 0.5) | 0;
    out[i] = gray;
    out[i + 1] = gray;
    out[i + 2] = gray;
    out[i + 3] = 255;
  }

  return {
    gain: new ImageData(out, base.width, base.height),
    meta: {
      gainMapMax: log2Max,
      gainMapMin: 0,
      gamma: 1,
      offsetSdr: 1 / 64,
      offsetHdr: 1 / 64,
      hdrCapacityMin: 0,
      hdrCapacityMax: log2Max,
    },
  };
}
