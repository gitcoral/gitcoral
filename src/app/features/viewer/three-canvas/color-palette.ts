import { Color } from 'three';

export const DEFAULT_COLOR = new Color(0x8892a4);

export function toHex(c: Color): string {
  return '#' + c.clone().convertLinearToSRGB().getHexString();
}

// Assigns a unique, visually distinct colour to each file extension,
// sorted by frequency so the most common extensions get the most distinct hues.
export function buildExtColorMap(extCounts: Map<string, number>): Map<string, Color> {
  const GOLDEN = 0.61803398875;
  const sorted = [...extCounts.entries()].sort((a, b) => b[1] - a[1]);
  const map    = new Map<string, Color>();
  for (let i = 0; i < sorted.length; i++) {
    const hue       = Math.round((i * GOLDEN % 1) * 360);
    const lightness = i % 2 === 0 ? 65 : 75;
    map.set(sorted[i][0], new Color(`hsl(${hue},80%,${lightness}%)`));
  }
  return map;
}
