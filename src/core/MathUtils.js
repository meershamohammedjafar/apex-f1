export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const MPS_TO_KPH = 3.6;
export const KPH_TO_MPS = 1 / 3.6;
export const G = 9.80665;
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function lerp(a, b, t) {
  return a + (b - a) * t;
}
export function invLerp(a, b, v) {
  return a === b ? 0 : (v - a) / (b - a);
}
export function remap(v, inMin, inMax, outMin, outMax) {
  return lerp(outMin, outMax, clamp01(invLerp(inMin, inMax, v)));
}
export function smoothstep(edge0, edge1, x) {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}
export function smootherstep(edge0, edge1, x) {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}
export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}
export function sign(v) {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}
export function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
export function wrap01(t) {
  t %= 1;
  return t < 0 ? t + 1 : t;
}
export function deltaT(from, to) {
  let d = to - from;
  while (d > 0.5) d -= 1;
  while (d < -0.5) d += 1;
  return d;
}
export function formatLapTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(3)}`;
}
export function formatGap(seconds, showPlus = true) {
  if (!Number.isFinite(seconds)) return "--.---";
  const sgn = seconds < 0 ? "-" : showPlus ? "+" : "";
  return `${sgn}${Math.abs(seconds).toFixed(3)}`;
}
