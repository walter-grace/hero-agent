// Hero Run terminal palette. The web app's earthy heritage scheme (mineral green, brass, steel
// blue on warm stone) translated for dark terminal backgrounds: same hues, lifted luminance so
// they read on black without turning neon.
export const BRASS = "#d4a94e";
export const MINERAL = "#7fa893";
export const STEEL = "#6fa8bc";
export const STONE = "#8a8578";   // dim/quiet text
export const EMBER = "#c25e4c";   // errors only
export const PAPER = "#e8e4da";   // bright text

// Three-stop gradient across a string, with a moving phase for shimmer. Returns [{ch, color}].
const STOPS = [
  [0xd4, 0xa9, 0x4e], // brass
  [0x7f, 0xa8, 0x93], // mineral
  [0x6f, 0xa8, 0xbc], // steel
];
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const hex = (r, g, b) => `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;

export function gradient(text, phase = 0) {
  const n = Math.max(1, text.length - 1);
  return [...text].map((ch, i) => {
    // position 0..1 along the string, shifted by phase and folded so the sweep ping-pongs
    let t = ((i / n) + phase) % 2;
    if (t > 1) t = 2 - t;
    const seg = t < 0.5 ? 0 : 1;
    const u = (t - seg * 0.5) * 2;
    const [a, b] = [STOPS[seg], STOPS[seg + 1]];
    return { ch, color: hex(lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)) };
  });
}
