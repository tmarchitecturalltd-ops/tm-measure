export function parseMeters(value: string): number | null {
  const t = value.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  if (Number.isNaN(n) || !Number.isFinite(n)) return null;
  return n;
}
