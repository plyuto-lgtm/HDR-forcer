# Glow

A single-page client-side web app that turns any image into an HDR-tagged JPEG
that glows on iOS/macOS HDR displays. No backend. Drop an image, get a file.

## What it does, exactly

The output JPEG is tagged Rec.2020 + PQ, so HDR-aware OSes (iPhones, XDR Macs)
read its bright pixels as absolute luminance — they render brighter than
surrounding SDR UI and appear to glow. On non-HDR displays the image renders
as ordinary SDR.

The effect is a pure **assign**, not a convert: the JPEG keeps its
sRGB-encoded pixel values and tag it with the Rec.2020 + PQ profile. HDR-aware
OSes then reinterpret those values on the PQ curve, reading bright pixels as
high absolute luminance — so they glow.

There are two **modes** (toggle in the UI):

- **Assign** (default) — keep the original pixel values, only change the tag.
  This is how the known-good reference avatars (the cosmos profile) are built;
  the bundled profile's `A2B0` LUT defines how the values map. Strongest glow,
  but reinterpreting sRGB primaries as Rec.2020 can shift color. The **Glow**
  slider here is a brightness multiplier (0.5×–1.6×) baked in before export —
  raising it pushes more pixels into the bright end. Pure black stays black.

- **Convert** — properly remap each pixel sRGB → linear → Rec.2020 → PQ before
  tagging, so the values honestly match the profile (no color burn). The
  **White** slider picks where SDR diffuse white lands in nits (100–600,
  default 200); highlights above that get the PQ headroom and glow.

Use Assign for maximum glow that matches the reference; use Convert if the
Assign output looks oversaturated or color-shifted on your display.

The output JPEG embeds an ICC profile whose `cicp` tag carries:

- `ColourPrimaries: 9` (BT.2020 / Rec.2020)
- `TransferCharacteristics: 16` (PQ / SMPTE ST 2084)
- `MatrixCoefficients: 0` (RGB)
- `VideoFullRangeFlag: 1` (full range)

## Why this has to do byte-level JPEG editing

`canvas.toBlob('image/jpeg')` always writes an sRGB-tagged JPEG with a baked-in
sRGB ICC profile in an APP2 segment — the browser will not let you set a
different output color space. So the pipeline is:

1. Draw the image to an offscreen `<canvas>` at the selected output size (with
   optional center square-crop). In Assign mode the brightness multiplier is
   baked in here; in Convert mode every pixel is then remapped
   sRGB → Rec.2020 → PQ.
2. Encode the pixels to JPEG with **mozjpeg (WASM)** — not `canvas.toBlob` —
   so we control baseline (SOF0) vs progressive (SOF2). See below.
3. **Strip any sRGB APP2 ICC_PROFILE segment**, then splice in our own APP2
   segment carrying the Rec.2020 + PQ ICC profile.
4. Wrap the new bytes in a `Blob('image/jpeg')` and download.

The new APP2 segment is inserted right after the JFIF APP0 segment (or
directly after SOI if no APP0 is present). Stripping any existing profile
matters: leaving two around means decoders may pick the wrong one.

## Output options

- **Size** — longest-side cap (Original ≤1400 / 1024 / 800 / 400 / 200 px).
  Never upscales past native resolution.
- **Crop to square** — center-crops then scales to N×N (e.g. 400×400 for a
  LinkedIn avatar).
- **JPEG format** — baseline (SOF0) or progressive (SOF2). `canvas.toBlob`
  can only ever emit baseline; mozjpeg lets us emit progressive too.

### Why progressive matters

LinkedIn-hosted "glow" avatars that survive upload are **progressive** JPEGs.
A canvas-encoded baseline output was byte-for-byte structurally identical to
the cosmos reference *except the SOF marker* (0xFFC0 baseline vs 0xFFC2
progressive). LinkedIn's pipeline appears to treat the two differently — so we
encode with mozjpeg, default to progressive, and surface the actual SOF marker
in the "Verify CICP tags" panel. mozjpeg's defaults (4:2:0 subsampling,
optimized Huffman) already match the reference.

## Acceptance check

Open the **Verify CICP tags** disclosure after every export — it parses the
output JPEG's APP2 ICC segment back out and confirms primaries=9 and
transfer=16. If it says anything else, the build is broken and the file is not
HDR-tagged.

An offline pipeline check runs without a browser:

```bash
node --experimental-strip-types scripts/verify.ts
```

It builds the ICC profile, injects it into a stub JPEG, and asserts the
expected CICP codepoints. Used as a build gate.

## Files

```
public/rec2020_pq.icc canonical "Rec2020 Gamut with PQ Transfer" profile (9KB)
src/iccProfile.ts   loads the canonical profile as a static asset
src/encode.ts       Convert mode: per-pixel sRGB → linear → Rec.2020 → PQ
src/jpegEncode.ts   mozjpeg (WASM) encode — baseline (SOF0) or progressive (SOF2)
src/jpegInject.ts   strip the encoder's sRGB ICC, splice in our Rec.2020 PQ one
src/inspect.ts      parse APP2 + ICC back out, read CICP + SOF — the build gate
src/main.ts         drag-drop UI, canvas redraw, download pipeline
src/style.css       single-page styling
scripts/verify.ts   headless end-to-end pipeline check
```

## Why the canonical profile (not a minimal generated one)

A minimal profile with just a `cicp` tag and identity `rTRC`/`gTRC`/`bTRC`
curves is enough for HDR rendering on Apple displays — but it does **not**
survive LinkedIn's avatar processing. LinkedIn's pipeline appears to be
CICP-unaware: it parses the identity TRC, decides the profile is meaningless,
and strips it on re-encode. The avatar loses its glow.

The canonical Apple profile bundled in `public/rec2020_pq.icc` carries full
`A2B0`/`B2A0` multidimensional LUTs that bake the PQ transfer function into
the profile itself. CICP-unaware pipelines see a profile that actually
transforms colors and preserve it. The same profile is what's inside
LinkedIn-hosted "glow JPEGs" today; we extracted it from one and use it
verbatim.

## Stack

- Vite + vanilla TypeScript, single page, static output.
- No image libraries — canvas + hand-rolled byte manipulation on `Uint8Array`.
- Deploys to Vercel as static files (`npm run build` → `dist/`).

```bash
npm install
npm run dev        # local dev
npm run build      # static build → dist/
npm run preview    # serve the built output
```
