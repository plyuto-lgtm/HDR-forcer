// Parse a JPEG's APP2 ICC_PROFILE segment and extract the CICP codepoints,
// so we can verify our injection actually landed (primaries=9, transfer=16).
// This is what gates "build done" — never claim a file is HDR-tagged without
// running this on real exported bytes.

export interface IccInspectResult {
  hasIccProfile: boolean;
  profileBytes: number;
  cicp?: {
    colourPrimaries: number;
    transferCharacteristics: number;
    matrixCoefficients: number;
    videoFullRangeFlag: number;
  };
  isHdrTagged: boolean; // primaries === 9 && transfer === 16
  sof?: "baseline" | "progressive" | "other";
}

// Read the Start-Of-Frame marker to classify the JPEG: SOF0 (0xC0) = baseline,
// SOF2 (0xC2) = progressive. Anything else (arithmetic, etc.) = "other".
function readSof(jpeg: Uint8Array): IccInspectResult["sof"] {
  let i = 2;
  while (i < jpeg.length - 1) {
    if (jpeg[i] !== 0xff) break;
    const m = jpeg[i + 1];
    if (m === 0xc0) return "baseline";
    if (m === 0xc2) return "progressive";
    if (m === 0xd9 || m === 0xda) break; // EOI / SOS
    if (m >= 0xd0 && m <= 0xd7) {
      i += 2;
      continue;
    }
    if (i + 4 > jpeg.length) break;
    i += 2 + ((jpeg[i + 2] << 8) | jpeg[i + 3]);
  }
  // SOF1/SOF3+ are rare; treat as "other" rather than misreporting.
  return "other";
}

function sigAt(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
}

function readICCfromJpeg(jpeg: Uint8Array): Uint8Array | null {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let i = 2;
  // Collect all APP2 ICC chunks (in order) and concatenate.
  const chunks: Array<{ n: number; total: number; data: Uint8Array }> = [];
  while (i < jpeg.length - 1) {
    if (jpeg[i] !== 0xff) break;
    const marker = jpeg[i + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS — end of metadata
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2; // RSTn standalone
      continue;
    }
    if (i + 4 > jpeg.length) break;
    const segLen = (jpeg[i + 2] << 8) | jpeg[i + 3];
    const segStart = i + 4;
    const segEnd = i + 2 + segLen;
    if (marker === 0xe2 && segLen >= 16) {
      // APP2 — check identifier
      const id = String.fromCharCode(...jpeg.subarray(segStart, segStart + 11));
      if (id === "ICC_PROFILE" && jpeg[segStart + 11] === 0x00) {
        const chunkN = jpeg[segStart + 12];
        const chunkTotal = jpeg[segStart + 13];
        chunks.push({
          n: chunkN,
          total: chunkTotal,
          data: jpeg.subarray(segStart + 14, segEnd),
        });
      }
    }
    i = segEnd;
  }
  if (!chunks.length) return null;
  chunks.sort((a, b) => a.n - b.n);
  const totalLen = chunks.reduce((s, c) => s + c.data.length, 0);
  const out = new Uint8Array(totalLen);
  let cursor = 0;
  for (const c of chunks) {
    out.set(c.data, cursor);
    cursor += c.data.length;
  }
  return out;
}

function findCicpInIcc(icc: Uint8Array): IccInspectResult["cicp"] | undefined {
  if (icc.length < 132) return undefined;
  const dv = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const tagCount = dv.getUint32(128, false);
  for (let t = 0; t < tagCount; t++) {
    const entry = 132 + t * 12;
    if (entry + 12 > icc.length) break;
    const tagSig = sigAt(icc, entry);
    const tagOffset = dv.getUint32(entry + 4, false);
    const tagSize = dv.getUint32(entry + 8, false);
    if (tagSig === "cicp" && tagSize >= 12 && tagOffset + 12 <= icc.length) {
      // Body: sig(4) reserved(4) cp(1) tc(1) mc(1) fr(1)
      return {
        colourPrimaries: icc[tagOffset + 8],
        transferCharacteristics: icc[tagOffset + 9],
        matrixCoefficients: icc[tagOffset + 10],
        videoFullRangeFlag: icc[tagOffset + 11],
      };
    }
  }
  return undefined;
}

export function inspectJpeg(jpeg: Uint8Array): IccInspectResult {
  const sof = readSof(jpeg);
  const icc = readICCfromJpeg(jpeg);
  if (!icc) {
    return { hasIccProfile: false, profileBytes: 0, isHdrTagged: false, sof };
  }
  const cicp = findCicpInIcc(icc);
  return {
    hasIccProfile: true,
    profileBytes: icc.length,
    cicp,
    isHdrTagged: cicp?.colourPrimaries === 9 && cicp?.transferCharacteristics === 16,
    sof,
  };
}

// --- UltraHDR (gain map) verification ---

export interface UltraHdrInspectResult {
  hasXmpVersion: boolean; // primary XMP declares hdrgm:Version
  hasGainMapSemantic: boolean; // GContainer lists a GainMap item
  mpfImageCount: number; // images declared in the MPF index (expect 2)
  secondImageOffset: number; // byte offset of the gain-map SOI (0 if not found)
  secondImageIsJpeg: boolean; // those bytes start with SOI
  gainMapMax?: number; // parsed hdrgm:GainMapMax
  isValid: boolean;
}

function findApp1Xmp(jpeg: Uint8Array): string | null {
  let i = 2;
  while (i < jpeg.length - 1) {
    if (jpeg[i] !== 0xff) break;
    const m = jpeg[i + 1];
    if (m === 0xd9 || m === 0xda) break;
    if (m >= 0xd0 && m <= 0xd7) {
      i += 2;
      continue;
    }
    if (i + 4 > jpeg.length) break;
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (m === 0xe1) {
      const id = String.fromCharCode(...jpeg.subarray(i + 4, i + 4 + 28));
      if (id.startsWith("http://ns.adobe.com/xap/1.0/")) {
        const body = jpeg.subarray(i + 4 + 29, i + 2 + len);
        return String.fromCharCode(...body);
      }
    }
    i += 2 + len;
  }
  return null;
}

function findMpf(jpeg: Uint8Array): { count: number; secondOffset: number } {
  let i = 2;
  while (i < jpeg.length - 1) {
    if (jpeg[i] !== 0xff) break;
    const m = jpeg[i + 1];
    if (m === 0xd9 || m === 0xda) break;
    if (m >= 0xd0 && m <= 0xd7) {
      i += 2;
      continue;
    }
    if (i + 4 > jpeg.length) break;
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (m === 0xe2 && String.fromCharCode(jpeg[i + 4], jpeg[i + 5], jpeg[i + 6]) === "MPF") {
      const base = i + 8; // "MM" byte (after marker+len+"MPF\0")
      const dv = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
      const ifdOff = dv.getUint32(base + 4, false);
      const count = dv.getUint16(base + ifdOff, false);
      let entryArrayOff = 0;
      let numImages = 0;
      for (let e = 0; e < count; e++) {
        const tagPos = base + ifdOff + 2 + e * 12;
        const tag = dv.getUint16(tagPos, false);
        if (tag === 0xb001) numImages = dv.getUint32(tagPos + 8, false);
        if (tag === 0xb002) entryArrayOff = dv.getUint32(tagPos + 8, false);
      }
      // Second MP entry: 16 bytes each; entry 1 offset field is at +24.
      let secondOffset = 0;
      if (entryArrayOff && numImages >= 2) {
        const rel = dv.getUint32(base + entryArrayOff + 16 + 8, false);
        secondOffset = base + rel; // absolute in file
      }
      return { count: numImages, secondOffset };
    }
    i += 2 + len;
  }
  return { count: 0, secondOffset: 0 };
}

export function inspectUltraHdr(jpeg: Uint8Array): UltraHdrInspectResult {
  const xmp = findApp1Xmp(jpeg) ?? "";
  const hasXmpVersion = /hdrgm:Version\s*=\s*"1\.0"/.test(xmp);
  const hasGainMapSemantic = /Item:Semantic\s*=\s*"GainMap"/.test(xmp);
  const { count, secondOffset } = findMpf(jpeg);
  const secondImageIsJpeg =
    secondOffset > 0 &&
    secondOffset + 1 < jpeg.length &&
    jpeg[secondOffset] === 0xff &&
    jpeg[secondOffset + 1] === 0xd8;
  // GainMapMax appears in the gain map's own XMP (second image). Decode as
  // latin1 (chunk-safe) rather than spreading a huge array into fromCharCode.
  let gainMapMax: number | undefined;
  const allText = new TextDecoder("latin1").decode(jpeg);
  const mm = allText.match(/hdrgm:GainMapMax\s*=\s*"([\d.]+)"/);
  if (mm) gainMapMax = parseFloat(mm[1]);
  return {
    hasXmpVersion,
    hasGainMapSemantic,
    mpfImageCount: count,
    secondImageOffset: secondOffset,
    secondImageIsJpeg,
    gainMapMax,
    isValid:
      hasXmpVersion && hasGainMapSemantic && count === 2 && secondImageIsJpeg,
  };
}
