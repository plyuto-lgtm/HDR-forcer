// The canonical Apple "Rec.2020 Gamut with PQ Transfer" ICC profile, fetched
// as a static asset from /public/rec2020_pq.icc. ~9KB.
//
// Why this one and not a hand-rolled minimal profile: services that re-encode
// images (LinkedIn, most notably) appear to strip ICC profiles they consider
// "minimal" or "incomplete" — CICP-only profiles with identity TRCs get
// thrown away. The canonical Apple profile carries full A2B0/B2A0
// multidimensional LUTs that bake in the PQ transfer function. Profile
// pipelines that don't understand CICP can still see "this profile actually
// transforms colors," so they preserve it. Result: the JPEG survives upload
// to LinkedIn and the avatar still glows on HDR.
//
// Profile contents (verified against the source JPEG):
//   description: "Rec2020 Gamut with PQ Transfer"
//   version 4.4, mntr/RGB/XYZ, D50 PCS
//   tags: desc, rXYZ, gXYZ, bXYZ, wtpt, cicp, A2B0 (8616B mAB), B2A0, cprt
//   CICP: primaries=9 (Rec.2020), transfer=16 (PQ), full-range

import profileUrl from "/rec2020_pq.icc?url";

let cached: Uint8Array | null = null;
let inflight: Promise<Uint8Array> | null = null;

export async function loadRec2020PQProfile(): Promise<Uint8Array> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await fetch(profileUrl);
    if (!res.ok) throw new Error(`Failed to fetch ICC profile: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    cached = buf;
    inflight = null;
    return buf;
  })();
  return inflight;
}
