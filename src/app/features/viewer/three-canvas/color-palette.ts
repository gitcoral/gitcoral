import { Color } from 'three';
import { PositionedNode } from '../../../shared/models/tree-node.model';
import { fileExt, parentPath } from './scene-utils';

export const DEFAULT_COLOR = new Color(0x8892a4);

export function toHex(c: Color): string {
  return '#' + c.clone().convertLinearToSRGB().getHexString();
}

// ---------------------------------------------------------------------------
// Extension coloring
// ---------------------------------------------------------------------------

// Assigns a unique, visually distinct colour to each file extension,
// sorted by frequency so the most common extensions get the most distinct hues.
export function buildExtColorMap(extCounts: Map<string, number>): Map<string, Color> {
  const GOLDEN = 0.61803398875;
  const sorted = [...extCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const map = new Map<string, Color>();
  for (let i = 0; i < sorted.length; i++) {
    const hue = Math.round(((i * GOLDEN) % 1) * 360);
    const lightness = i % 2 === 0 ? 65 : 75;
    map.set(sorted[i][0], new Color(`hsl(${hue},80%,${lightness}%)`));
  }
  return map;
}

export function buildExtColorFn(
  allFiles: PositionedNode[],
  folders: PositionedNode[],
  allNodes: PositionedNode[],
): (n: PositionedNode) => Color {
  const extCounts = new Map<string, number>();
  for (const n of allFiles) {
    const ext = fileExt(n.path);
    if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }
  const extColorMap = buildExtColorMap(extCounts);
  const fileColor = (path: string): Color => {
    const ext = fileExt(path);
    return ext ? (extColorMap.get(ext) ?? DEFAULT_COLOR) : DEFAULT_COLOR;
  };

  // Bottom-up: average children's colors into each folder (deepest folders first)
  const childrenOf = buildChildrenMap(allNodes);
  const folderColorMap = new Map<string, Color>();
  for (const folder of [...folders].sort(
    (a, b) => b.path.split('/').length - a.path.split('/').length,
  )) {
    const children = childrenOf.get(folder.path) ?? [];
    if (!children.length) {
      folderColorMap.set(folder.path, DEFAULT_COLOR);
      continue;
    }
    const colors = children.map((c) =>
      c.isFile ? fileColor(c.path) : (folderColorMap.get(c.path) ?? DEFAULT_COLOR),
    );
    folderColorMap.set(folder.path, averageColors(colors));
  }

  return (n: PositionedNode): Color =>
    n.isFile ? fileColor(n.path) : (folderColorMap.get(n.path) ?? DEFAULT_COLOR);
}

// ---------------------------------------------------------------------------
// Depth coloring
// ---------------------------------------------------------------------------

// Colors nodes by their depth in the hierarchy.
// Hue rotates from warm (shallow) to cool (deep) at constant saturation/lightness,
// so every level stays vivid with no muddy midpoints.
export function buildDepthColorFn(allNodes: PositionedNode[]): (n: PositionedNode) => Color {
  const depths = allNodes.map((n) => (n.path === '' ? 0 : n.path.split('/').length));
  const maxDepth = Math.max(...depths, 1);

  return (n: PositionedNode): Color => {
    const depth = n.path === '' ? 0 : n.path.split('/').length;
    const t = depth / maxDepth;
    // Full rainbow sweep: violet (270°) → blue → cyan → green → yellow → red (0°)
    return hueColor(DEPTH_HUE_SHALLOW * (1 - t));
  };
}

const DEPTH_HUE_SHALLOW = 270; // violet at root, red at deepest

// ---------------------------------------------------------------------------
// File-size coloring
// ---------------------------------------------------------------------------

// Colors nodes by byte size using rank-based mapping so the full rainbow is always
// used regardless of size distribution. Folders use subtreeBytes; files use fileSize.
export function buildFileSizeColorFn(allNodes: PositionedNode[]): (n: PositionedNode) => Color {
  const byteOf = (n: PositionedNode) => (n.isFile ? (n.fileSize ?? 0) : n.subtreeBytes);
  const sorted = [...allNodes].sort((a, b) => byteOf(a) - byteOf(b));
  const rankMap = new Map<PositionedNode, number>();
  const last = sorted.length - 1;
  sorted.forEach((n, i) => rankMap.set(n, last > 0 ? i / last : 0));

  return (n: PositionedNode): Color => {
    const t = rankMap.get(n) ?? 0;
    // Full rainbow sweep: violet (270°) → blue → cyan → green → yellow → red (0°)
    return hueColor(270 * (1 - t));
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Interpolates hue in degrees, always taking the shortest arc around the wheel.
// Saturation and lightness are fixed so every output color is equally vivid.
export function lerpHue(hueA: number, hueB: number, t: number): number {
  let diff = hueB - hueA;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return (((hueA + diff * t) % 360) + 360) % 360;
}

export function hueColor(hue: number, saturation = 85, lightness = 65): Color {
  return new Color(`hsl(${Math.round(hue)},${saturation}%,${lightness}%)`);
}

// Linear RGB interpolation — used for folder color averaging in extension mode.
export function lerpColor(a: Color, b: Color, t: number): Color {
  return new Color(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}

export function averageColors(colors: Color[]): Color {
  if (!colors.length) return DEFAULT_COLOR;
  let r = 0,
    g = 0,
    bl = 0;
  for (const c of colors) {
    r += c.r;
    g += c.g;
    bl += c.b;
  }
  return new Color(r / colors.length, g / colors.length, bl / colors.length);
}

export function buildChildrenMap(nodes: PositionedNode[]): Map<string, PositionedNode[]> {
  const map = new Map<string, PositionedNode[]>();
  for (const n of nodes) {
    const p = parentPath(n.path);
    if (!map.has(p)) map.set(p, []);
    map.get(p)!.push(n);
  }
  return map;
}
