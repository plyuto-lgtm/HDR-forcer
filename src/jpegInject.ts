// Replace any APP2 "ICC_PROFILE" segments in a JPEG with a fresh one carrying
// our Rec.2020 + PQ profile.
//
// Why this is necessary: canvas.toBlob('image/jpeg') ALREADY embeds an sRGB
// ICC profile in an APP2 segment. If we just append our PQ profile, decoders
// may pick the wrong one (order-of-precedence varies by OS/library). So we
// strip every existing ICC_PROFILE segment first, then splice ours in.
//
// APP2 segment layout (single chunk — our profile is well under 64KB):
//   0xFF 0xE2                                 marker
//   2-byte big-endian segment length          (= 2 + 12 + 2 + profileLength)
//   "ICC_PROFILE\0"                           12-byte identifier
//   chunkNumber=1, chunkCount=1               2 bytes
//   <profile bytes>
//
// We insert the new segment right after a JFIF APP0 segment if present,
// otherwise directly after SOI. That placement matches what real JPEG
// encoders do when they natively embed ICCs.

const MAX_CHUNK_PROFILE_BYTES = 65519; // 65533 segment length cap − (12 id + 2 chunk)
const ICC_ID = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]; // "ICC_PROFILE\0"

function stripExistingIccSegments(jpeg: Uint8Array): Uint8Array {
  // Walk APPn segments at the top of the file and drop any APP2 whose
  // identifier is "ICC_PROFILE\0". Stop at SOS (0xFFDA) — beyond that lies
  // entropy-coded image data that can contain bytes resembling markers.
  const kept: Array<[number, number]> = []; // [start, end) ranges to keep
  let cursor = 0;
  let i = 2; // skip SOI
  while (i < jpeg.length - 1) {
    if (jpeg[i] !== 0xff) break;
    const marker = jpeg[i + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS — image data follows
    if (marker >= 0xd0 && marker <= 0xd7) {
      // RSTn — standalone, no length
      i += 2;
      continue;
    }
    if (i + 4 > jpeg.length) break;
    const segLen = (jpeg[i + 2] << 8) | jpeg[i + 3];
    const segEnd = i + 2 + segLen;
    let drop = false;
    if (marker === 0xe2 && segLen >= 2 + ICC_ID.length) {
      drop = true;
      for (let k = 0; k < ICC_ID.length; k++) {
        if (jpeg[i + 4 + k] !== ICC_ID[k]) {
          drop = false;
          break;
        }
      }
    }
    if (drop) {
      // Emit everything up to i, then skip [i, segEnd)
      if (i > cursor) kept.push([cursor, i]);
      cursor = segEnd;
    }
    i = segEnd;
  }
  if (cursor < jpeg.length) kept.push([cursor, jpeg.length]);
  if (!kept.length) return jpeg; // nothing dropped
  if (kept.length === 1 && kept[0][0] === 0 && kept[0][1] === jpeg.length) return jpeg;
  const total = kept.reduce((s, [a, b]) => s + (b - a), 0);
  const out = new Uint8Array(total);
  let w = 0;
  for (const [a, b] of kept) {
    out.set(jpeg.subarray(a, b), w);
    w += b - a;
  }
  return out;
}

function findInsertOffset(jpeg: Uint8Array): number {
  // After SOI; if the next marker is APP0/JFIF, insert after that segment.
  if (jpeg.length < 4) return 2;
  if (jpeg[2] !== 0xff || jpeg[3] !== 0xe0 || jpeg.length < 6) return 2;
  // APP0 length field is big-endian and counts the length field itself
  // but NOT the 2-byte marker — segment ends at 4 + app0Len.
  const app0Len = (jpeg[4] << 8) | jpeg[5];
  return 4 + app0Len;
}

export function injectIccProfile(jpeg: Uint8Array, profile: Uint8Array): Uint8Array {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("Not a JPEG (missing SOI marker)");
  }
  if (profile.length > MAX_CHUNK_PROFILE_BYTES) {
    // Our generated profile is ~500 bytes and any sane hand-crafted one is
    // ~9KB, so this branch shouldn't fire — but the spec allows multi-chunk
    // and we'd need to handle it for arbitrarily large profiles.
    throw new Error(
      `ICC profile is ${profile.length} bytes; multi-chunk APP2 not implemented`,
    );
  }

  const clean = stripExistingIccSegments(jpeg);
  const insertAt = findInsertOffset(clean);

  const segmentLen = 2 + ICC_ID.length + 2 + profile.length; // length-field + id + chunk(2) + profile
  const segment = new Uint8Array(2 + segmentLen); // marker + body
  segment[0] = 0xff;
  segment[1] = 0xe2;
  segment[2] = (segmentLen >> 8) & 0xff;
  segment[3] = segmentLen & 0xff;
  for (let k = 0; k < ICC_ID.length; k++) segment[4 + k] = ICC_ID[k];
  segment[4 + ICC_ID.length] = 0x01; // chunk number
  segment[5 + ICC_ID.length] = 0x01; // chunk count
  segment.set(profile, 6 + ICC_ID.length);

  const out = new Uint8Array(clean.length + segment.length);
  out.set(clean.subarray(0, insertAt), 0);
  out.set(segment, insertAt);
  out.set(clean.subarray(insertAt), insertAt + segment.length);
  return out;
}
