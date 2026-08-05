/**
 * Stable 32-bit numeric id from uid for MapLibre GeoJSONSourceDiff.
 * Matches CloudTAK's approach of avoiding string feature ids in updateData.
 */
export function vectorId(uid: string): number {
  const s = String(uid || "");
  if (!s) return 1;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // MapLibre prefers non-negative ids; keep in signed 32-bit positive range
  return h >>> 0 || 1;
}
