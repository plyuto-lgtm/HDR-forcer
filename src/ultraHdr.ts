// Assemble an UltraHDR (gain-map) JPEG by hand — the same byte-injection
// approach we use for the ICC profile, applied to the MPF + XMP structure.
//
// File layout (one .jpg):
//   [Primary SDR JPEG]
//     SOI, APP0/JFIF,
//     APP1 "http://ns.adobe.com/xap/1.0/\0" + XMP   (GContainer + hdrgm:Version)
//     APP2 "MPF\0" + MP Index IFD                    (offsets/sizes of both images)
//     ...image data... EOI
//   [Gain-map JPEG]
//     SOI, APP1 XMP (hdrgm decode params), ...image data... EOI
//
// A non-HDR decoder shows the primary SDR image and ignores the rest, so the
// file degrades gracefully. HDR-aware decoders (Chrome 116+, iOS Photos,
// Safari 26+) reconstruct HDR = SDR boosted by the gain map.
//
// Refs: Android UltraHDR format; Adobe gain map (hdrgm) spec; CIPA DC-007 MPF.

import type { GainMapMeta } from "./gainMap.ts";

const XMP_ID = "http://ns.adobe.com/xap/1.0/\0";

function strBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// Build an APP1 XMP segment (marker + length + identifier + packet).
function buildXmpApp1(xmp: string): Uint8Array {
  const id = strBytes(XMP_ID);
  const body = strBytes(xmp);
  const segLen = 2 + id.length + body.length; // length field counts itself
  const seg = new Uint8Array(2 + segLen);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = (segLen >> 8) & 0xff;
  seg[3] = segLen & 0xff;
  seg.set(id, 4);
  seg.set(body, 4 + id.length);
  return seg;
}

// Build the APP2 MPF segment for a 2-image (primary + gain map) file.
// Entry sizes/offsets are filled by the caller after final assembly, but the
// segment is fixed-length so we can locate and patch it in place.
function buildMpfApp2(): { seg: Uint8Array; entryArrayOffsetInSeg: number } {
  // Payload after the marker+length: "MPF\0" + TIFF/MP index.
  // TIFF header (8) + IFD(2 + 3*12 + 4 = 42) + MP entries (2*16 = 32) = 82.
  // Plus "MPF\0" (4) = 86 payload. segLen = 2 + 86 = 88 = 0x58.
  const seg = new Uint8Array(2 + 88);
  const dv = new DataView(seg.buffer);
  let o = 0;
  seg[o++] = 0xff;
  seg[o++] = 0xe2; // APP2
  dv.setUint16(o, 88, false);
  o += 2;
  // "MPF\0" — MPF endian base begins at the NEXT byte.
  seg[o++] = 0x4d;
  seg[o++] = 0x50;
  seg[o++] = 0x46;
  seg[o++] = 0x00;
  const base = o; // all MPF offsets are relative to here ("MM" byte)
  // TIFF big-endian header
  dv.setUint16(o, 0x4d4d, false);
  o += 2; // "MM"
  dv.setUint16(o, 0x002a, false);
  o += 2; // 42
  dv.setUint32(o, 8, false);
  o += 4; // offset to IFD0 = 8 (right after header)
  // IFD0
  dv.setUint16(o, 3, false);
  o += 2; // 3 entries
  // MPFVersion (0xB000) type=UNDEFINED(7) count=4 value="0100"
  dv.setUint16(o, 0xb000, false);
  dv.setUint16(o + 2, 7, false);
  dv.setUint32(o + 4, 4, false);
  seg[o + 8] = 0x30;
  seg[o + 9] = 0x31;
  seg[o + 10] = 0x30;
  seg[o + 11] = 0x30; // "0100"
  o += 12;
  // NumberOfImages (0xB001) type=LONG(4) count=1 value=2
  dv.setUint16(o, 0xb001, false);
  dv.setUint16(o + 2, 4, false);
  dv.setUint32(o + 4, 1, false);
  dv.setUint32(o + 8, 2, false);
  o += 12;
  // MPEntry (0xB002) type=UNDEFINED(7) count=32 value=offset-to-entry-array
  dv.setUint16(o, 0xb002, false);
  dv.setUint16(o + 2, 7, false);
  dv.setUint32(o + 4, 32, false);
  const entryArrayOffsetField = o + 8;
  o += 12;
  // next IFD offset = 0
  dv.setUint32(o, 0, false);
  o += 4;
  // entry array starts here; record its offset relative to MPF base
  const entryArrayOffsetInSeg = o;
  dv.setUint32(entryArrayOffsetField, o - base, false);
  // two 16-byte entries left zeroed for now
  return { seg, entryArrayOffsetInSeg };
}

// Insert offset: after SOI; if APP0/JFIF follows, after that segment.
function findInsertOffset(jpeg: Uint8Array): number {
  if (jpeg.length < 4) return 2;
  if (jpeg[2] !== 0xff || jpeg[3] !== 0xe0 || jpeg.length < 6) return 2;
  const app0Len = (jpeg[4] << 8) | jpeg[5];
  return 4 + app0Len;
}

function num(n: number): string {
  // Compact decimal without exponent; gain-map metadata values are small.
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function primaryXmp(gainMapJpegLength: number): string {
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" ` +
    `xmlns:Container="http://ns.google.com/photos/1.0/container/" ` +
    `xmlns:Item="http://ns.google.com/photos/1.0/container/item/" ` +
    `xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" ` +
    `hdrgm:Version="1.0">` +
    `<Container:Directory><rdf:Seq>` +
    `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>` +
    `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainMapJpegLength}"/></rdf:li>` +
    `</rdf:Seq></Container:Directory>` +
    `</rdf:Description></rdf:RDF></x:xmpmeta>` +
    `<?xpacket end="w"?>`
  );
}

function gainMapXmp(m: GainMapMeta): string {
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" ` +
    `xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" ` +
    `hdrgm:Version="1.0" ` +
    `hdrgm:BaseRenditionIsHDR="False" ` +
    `hdrgm:GainMapMin="${num(m.gainMapMin)}" ` +
    `hdrgm:GainMapMax="${num(m.gainMapMax)}" ` +
    `hdrgm:Gamma="${num(m.gamma)}" ` +
    `hdrgm:OffsetSDR="${num(m.offsetSdr)}" ` +
    `hdrgm:OffsetHDR="${num(m.offsetHdr)}" ` +
    `hdrgm:HDRCapacityMin="${num(m.hdrCapacityMin)}" ` +
    `hdrgm:HDRCapacityMax="${num(m.hdrCapacityMax)}"/>` +
    `</rdf:RDF></x:xmpmeta>` +
    `<?xpacket end="w"?>`
  );
}

// Splice a single APP1 XMP segment into a JPEG right after APP0/SOI.
function injectXmp(jpeg: Uint8Array, xmp: string): Uint8Array {
  const seg = buildXmpApp1(xmp);
  const at = findInsertOffset(jpeg);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(seg, at);
  out.set(jpeg.subarray(at), at + seg.length);
  return out;
}

export function assembleUltraHdr(
  primaryJpeg: Uint8Array,
  gainMapJpegRaw: Uint8Array,
  meta: GainMapMeta,
): Uint8Array {
  // 1. Gain-map image carries its own hdrgm XMP.
  const gainMapJpeg = injectXmp(gainMapJpegRaw, gainMapXmp(meta));

  // 2. Build the primary's XMP (knows the final gain-map length) and MPF.
  const xmpSeg = buildXmpApp1(primaryXmp(gainMapJpeg.length));
  const { seg: mpfSeg, entryArrayOffsetInSeg } = buildMpfApp2();

  // 3. Insert XMP then MPF right after APP0/JFIF in the primary.
  const at = findInsertOffset(primaryJpeg);
  const primary = new Uint8Array(primaryJpeg.length + xmpSeg.length + mpfSeg.length);
  primary.set(primaryJpeg.subarray(0, at), 0);
  primary.set(xmpSeg, at);
  primary.set(mpfSeg, at + xmpSeg.length);
  primary.set(primaryJpeg.subarray(at), at + xmpSeg.length + mpfSeg.length);

  // 4. Patch MPF entries now that the primary length is final.
  //    MPF base = "MM" byte = (mpf segment start) + 2 marker + 2 len + 4 "MPF\0".
  const mpfSegStart = at + xmpSeg.length;
  const mpfBaseAbs = mpfSegStart + 8;
  const entryAbs = mpfSegStart + entryArrayOffsetInSeg;
  const dv = new DataView(primary.buffer);
  // Entry 0 — Primary. attr=0x00030000 (baseline MP primary), size, offset=0.
  dv.setUint32(entryAbs + 0, 0x00030000, false);
  dv.setUint32(entryAbs + 4, primary.length, false);
  dv.setUint32(entryAbs + 8, 0, false);
  dv.setUint16(entryAbs + 12, 0, false);
  dv.setUint16(entryAbs + 14, 0, false);
  // Entry 1 — GainMap. attr=0, size, offset = position of gain-map SOI - MPF base.
  const gainMapOffset = primary.length - mpfBaseAbs;
  dv.setUint32(entryAbs + 16, 0x00000000, false);
  dv.setUint32(entryAbs + 20, gainMapJpeg.length, false);
  dv.setUint32(entryAbs + 24, gainMapOffset, false);
  dv.setUint16(entryAbs + 28, 0, false);
  dv.setUint16(entryAbs + 30, 0, false);

  // 5. Concatenate primary + gain map.
  const out = new Uint8Array(primary.length + gainMapJpeg.length);
  out.set(primary, 0);
  out.set(gainMapJpeg, primary.length);
  return out;
}
