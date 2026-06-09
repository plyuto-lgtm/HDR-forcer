// End-to-end pipeline check that runs without a browser:
//   build the ICC profile → inject into a minimal JPEG stub → parse it back
//   → assert CICP says primaries=9, transfer=16. Anything else exits non-zero.
//
// This is the build gate. If this fails, no real export is HDR.

import fs from "node:fs";
import { injectIccProfile } from "../src/jpegInject.ts";
import { inspectJpeg } from "../src/inspect.ts";

// In Node we read the binary asset directly; the browser path uses a fetch.
function getRec2020PQProfile(): Uint8Array {
  return new Uint8Array(fs.readFileSync("public/rec2020_pq.icc"));
}

// Minimal but structurally valid JPEG: SOI + APP0/JFIF + EOI.
// The decoder won't make a picture out of it, but our inspector only walks
// markers — that's all this test needs.
const jfif = new Uint8Array([
  0xff, 0xd8,                                     // SOI
  0xff, 0xe0, 0x00, 0x10,                         // APP0 marker, length=16
  0x4a, 0x46, 0x49, 0x46, 0x00,                   // "JFIF\0"
  0x01, 0x01,                                     // version 1.1
  0x01,                                           // units = DPI
  0x00, 0x48, 0x00, 0x48,                         // 72x72 DPI
  0x00, 0x00,                                     // no thumbnail
  0xff, 0xd9,                                     // EOI
]);

const profile = getRec2020PQProfile();
console.log(`ICC profile: ${profile.length} bytes`);

const tagged = injectIccProfile(jfif, profile);
console.log(`Tagged JPEG: ${tagged.length} bytes (added ${tagged.length - jfif.length})`);

// Sanity: APP2 must be inserted right after APP0.
// SOI(2) + APP0 marker(2) + APP0 length-field(2) + APP0 payload(14) = 20.
const expectedApp2At = 20;
const m1 = tagged[expectedApp2At];
const m2 = tagged[expectedApp2At + 1];
if (m1 !== 0xff || m2 !== 0xe2) {
  console.error(`FAIL: expected APP2 (0xFFE2) at offset ${expectedApp2At}, found 0x${m1.toString(16)}${m2.toString(16)}`);
  process.exit(1);
}

const report = inspectJpeg(tagged);
console.log("Inspector:", report);

if (!report.hasIccProfile) {
  console.error("FAIL: inspector did not find an ICC profile");
  process.exit(1);
}
if (!report.cicp) {
  console.error("FAIL: CICP tag missing from ICC profile");
  process.exit(1);
}
if (report.cicp.colourPrimaries !== 9) {
  console.error(`FAIL: colourPrimaries=${report.cicp.colourPrimaries}, expected 9`);
  process.exit(1);
}
if (report.cicp.transferCharacteristics !== 16) {
  console.error(`FAIL: transferCharacteristics=${report.cicp.transferCharacteristics}, expected 16`);
  process.exit(1);
}
if (report.cicp.videoFullRangeFlag !== 1) {
  console.error(`FAIL: videoFullRangeFlag=${report.cicp.videoFullRangeFlag}, expected 1`);
  process.exit(1);
}

console.log("PASS: pipeline produces a Rec.2020 + PQ tagged JPEG.");
