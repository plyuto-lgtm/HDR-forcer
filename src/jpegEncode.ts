// JPEG encoding via mozjpeg (WASM). We need this instead of canvas.toBlob
// because the browser canvas can ONLY emit baseline JPEGs (SOF0) — there is no
// API to request a progressive (SOF2) stream.
//
// Why progressive matters here: the LinkedIn-hosted "glow" avatars that
// actually survive upload are progressive JPEGs. Our canvas-encoded baseline
// outputs were byte-for-byte identical to the cosmos reference EXCEPT for the
// SOF marker (0xFFC0 baseline vs 0xFFC2 progressive). mozjpeg lets us emit
// either, so we can match the reference and test the hypothesis.
//
// mozjpeg defaults already match the reference: 4:2:0 chroma subsampling
// (chroma_subsample=2), optimized Huffman coding, progressive on.

import encode from "@jsquash/jpeg/encode";

export type JpegFlavor = "progressive" | "baseline";

export async function encodeJpeg(
  imageData: ImageData,
  quality: number,
  flavor: JpegFlavor,
): Promise<Uint8Array> {
  const buf = await encode(imageData, {
    quality,
    progressive: flavor === "progressive",
    baseline: flavor === "baseline",
  });
  return new Uint8Array(buf);
}
