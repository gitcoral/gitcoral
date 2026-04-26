import { describe, it, expect } from 'vitest';
import { Color } from 'three';
import {
  DEFAULT_COLOR,
  toHex,
  buildExtColorMap,
  buildExtColorFn,
  buildDepthColorFn,
  buildFileSizeColorFn,
  lerpColor,
  lerpHue,
  hueColor,
  averageColors,
  buildChildrenMap,
} from './color-palette';
import { PositionedNode } from '../../../shared/models/tree-node.model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(path: string, isFile: boolean, fileSize = 0, subtreeBytes = 0): PositionedNode {
  return {
    path,
    isFile,
    fileSize: isFile ? fileSize : undefined,
    subtreeBytes,
    x: 0,
    y: 0,
    z: 0,
    connectionWidth: 0,
  };
}

// ---------------------------------------------------------------------------
// toHex
// ---------------------------------------------------------------------------

describe('toHex', () => {
  it('returns a lowercase hex string starting with #', () => {
    const hex = toHex(new Color(0xff0000));
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// ---------------------------------------------------------------------------
// lerpHue
// ---------------------------------------------------------------------------

describe('lerpHue', () => {
  it('returns hueA at t=0', () => {
    expect(lerpHue(30, 200, 0)).toBeCloseTo(30);
  });

  it('returns hueB at t=1', () => {
    expect(lerpHue(30, 200, 1)).toBeCloseTo(200);
  });

  it('returns midpoint at t=0.5 for non-wrapping case', () => {
    expect(lerpHue(0, 100, 0.5)).toBeCloseTo(50);
  });

  it('takes the short arc when wrapping (e.g. 350 → 10)', () => {
    // Short arc is +20°, not -340°
    expect(lerpHue(350, 10, 0.5)).toBeCloseTo(0);
  });

  it('result is always in [0, 360)', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const h = lerpHue(300, 60, t);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

// ---------------------------------------------------------------------------
// hueColor
// ---------------------------------------------------------------------------

describe('hueColor', () => {
  it('returns a Color instance', () => {
    expect(hueColor(120)).toBeInstanceOf(Color);
  });

  it('produces different colors for different hues', () => {
    const a = hueColor(0);
    const b = hueColor(180);
    expect(a.r === b.r && a.g === b.g && a.b === b.b).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lerpColor
// ---------------------------------------------------------------------------

describe('lerpColor', () => {
  it('returns a at t=0', () => {
    const a = new Color(1, 0, 0);
    const b = new Color(0, 0, 1);
    const result = lerpColor(a, b, 0);
    expect(result.r).toBeCloseTo(1);
    expect(result.g).toBeCloseTo(0);
    expect(result.b).toBeCloseTo(0);
  });

  it('returns b at t=1', () => {
    const a = new Color(1, 0, 0);
    const b = new Color(0, 0, 1);
    const result = lerpColor(a, b, 1);
    expect(result.r).toBeCloseTo(0);
    expect(result.b).toBeCloseTo(1);
  });

  it('returns midpoint at t=0.5', () => {
    const a = new Color(0, 0, 0);
    const b = new Color(1, 1, 1);
    const result = lerpColor(a, b, 0.5);
    expect(result.r).toBeCloseTo(0.5);
    expect(result.g).toBeCloseTo(0.5);
    expect(result.b).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// averageColors
// ---------------------------------------------------------------------------

describe('averageColors', () => {
  it('returns DEFAULT_COLOR for empty array', () => {
    const result = averageColors([]);
    expect(result.r).toBeCloseTo(DEFAULT_COLOR.r);
    expect(result.g).toBeCloseTo(DEFAULT_COLOR.g);
    expect(result.b).toBeCloseTo(DEFAULT_COLOR.b);
  });

  it('returns the single color unchanged', () => {
    const c = new Color(0.5, 0.2, 0.8);
    const result = averageColors([c]);
    expect(result.r).toBeCloseTo(0.5);
    expect(result.g).toBeCloseTo(0.2);
    expect(result.b).toBeCloseTo(0.8);
  });

  it('averages two colors correctly', () => {
    const a = new Color(1, 0, 0);
    const b = new Color(0, 0, 1);
    const result = averageColors([a, b]);
    expect(result.r).toBeCloseTo(0.5);
    expect(result.b).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// buildChildrenMap
// ---------------------------------------------------------------------------

describe('buildChildrenMap', () => {
  it('maps root children correctly', () => {
    const nodes = [node('src', false), node('readme.md', true)];
    const map = buildChildrenMap(nodes);
    expect(map.get('')).toHaveLength(2);
  });

  it('maps nested children correctly', () => {
    const nodes = [node('src/a.ts', true), node('src/b.ts', true)];
    const map = buildChildrenMap(nodes);
    expect(map.get('src')).toHaveLength(2);
  });

  it('returns empty map for empty input', () => {
    expect(buildChildrenMap([])).toEqual(new Map());
  });
});

// ---------------------------------------------------------------------------
// buildExtColorMap
// ---------------------------------------------------------------------------

describe('buildExtColorMap', () => {
  it('returns an empty map for empty input', () => {
    expect(buildExtColorMap(new Map())).toEqual(new Map());
  });

  it('assigns a Color to each extension', () => {
    const map = buildExtColorMap(
      new Map([
        ['ts', 10],
        ['js', 5],
      ]),
    );
    expect(map.has('ts')).toBe(true);
    expect(map.has('js')).toBe(true);
    expect(map.get('ts')).toBeInstanceOf(Color);
  });

  it('assigns distinct colors to different extensions', () => {
    const map = buildExtColorMap(
      new Map([
        ['ts', 10],
        ['js', 5],
        ['css', 3],
      ]),
    );
    const colors = [...map.values()].map((c) => `${c.r},${c.g},${c.b}`);
    const unique = new Set(colors);
    expect(unique.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// buildExtColorFn
// ---------------------------------------------------------------------------

describe('buildExtColorFn', () => {
  it('returns a function', () => {
    expect(typeof buildExtColorFn([], [], [])).toBe('function');
  });

  it('returns DEFAULT_COLOR for a file with no extension', () => {
    const f = node('Makefile', true, 100, 100);
    const fn = buildExtColorFn([f], [], [f]);
    const c = fn(f);
    expect(c.r).toBeCloseTo(DEFAULT_COLOR.r);
    expect(c.g).toBeCloseTo(DEFAULT_COLOR.g);
    expect(c.b).toBeCloseTo(DEFAULT_COLOR.b);
  });

  it('returns the same color for two files with the same extension', () => {
    const a = node('src/a.ts', true, 10, 10);
    const b = node('src/b.ts', true, 20, 20);
    const fn = buildExtColorFn([a, b], [], [a, b]);
    const ca = fn(a);
    const cb = fn(b);
    expect(ca.r).toBeCloseTo(cb.r);
    expect(ca.g).toBeCloseTo(cb.g);
    expect(ca.b).toBeCloseTo(cb.b);
  });

  it('returns different colors for files with different extensions', () => {
    const ts = node('a.ts', true, 10, 10);
    const css = node('b.css', true, 10, 10);
    const fn = buildExtColorFn([ts, css], [], [ts, css]);
    const ct = fn(ts);
    const cc = fn(css);
    expect(ct.r === cc.r && ct.g === cc.g && ct.b === cc.b).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildDepthColorFn
// ---------------------------------------------------------------------------

describe('buildDepthColorFn', () => {
  it('returns a function', () => {
    expect(typeof buildDepthColorFn([])).toBe('function');
  });

  it('root node gets violet (high blue channel)', () => {
    const root = node('', false, 0, 100);
    const deep = node('a/b/c', false, 0, 10);
    const fn = buildDepthColorFn([root, deep]);
    const color = fn(root);
    // t=0 → hue 270 (violet): blue dominates
    expect(color.b).toBeGreaterThan(color.r);
  });

  it('deepest node gets red (high red channel)', () => {
    const root = node('', false, 0, 100);
    const deep = node('a/b/c', false, 0, 10);
    const fn = buildDepthColorFn([root, deep]);
    const color = fn(deep);
    // t=1 → hue 0 (red): red dominates
    expect(color.r).toBeGreaterThan(color.b);
  });

  it('mid-depth node has a different color from both extremes', () => {
    const nodes = [node('', false, 0, 0), node('a', false, 0, 0), node('a/b', false, 0, 0)];
    const fn = buildDepthColorFn(nodes);
    const shallow = fn(nodes[0]);
    const mid = fn(nodes[1]);
    const deep = fn(nodes[2]);
    // Mid should differ from both ends
    expect(mid.r === shallow.r && mid.g === shallow.g && mid.b === shallow.b).toBe(false);
    expect(mid.r === deep.r && mid.g === deep.g && mid.b === deep.b).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildFileSizeColorFn
// ---------------------------------------------------------------------------

describe('buildFileSizeColorFn', () => {
  it('returns a function', () => {
    expect(typeof buildFileSizeColorFn([])).toBe('function');
  });

  it('zero-size file gets violet (high blue channel)', () => {
    const small = node('a.ts', true, 0, 0);
    const large = node('b.ts', true, 1_000_000, 1_000_000);
    const fn = buildFileSizeColorFn([small, large]);
    const color = fn(small);
    // t=0 → hue 270 (violet): blue dominates
    expect(color.b).toBeGreaterThan(color.r);
  });

  it('largest file gets red (high red channel)', () => {
    const small = node('a.ts', true, 0, 0);
    const large = node('b.ts', true, 1_000_000, 1_000_000);
    const fn = buildFileSizeColorFn([small, large]);
    const color = fn(large);
    // t=1 → hue 0 (red): red dominates
    expect(color.r).toBeGreaterThan(color.b);
  });

  it('uses subtreeBytes for folders', () => {
    const folder = node('src', false, 0, 500_000);
    const fn = buildFileSizeColorFn([folder]);
    // Should not throw and should return a Color
    expect(fn(folder)).toBeInstanceOf(Color);
  });

  it('mid-size file has a different color from both extremes', () => {
    const small = node('a.ts', true, 0, 0);
    const mid = node('b.ts', true, 1_000, 1_000);
    const large = node('c.ts', true, 1_000_000, 1_000_000);
    const fn = buildFileSizeColorFn([small, mid, large]);
    const cs = fn(small);
    const cm = fn(mid);
    const cl = fn(large);
    expect(cm.r === cs.r && cm.g === cs.g && cm.b === cs.b).toBe(false);
    expect(cm.r === cl.r && cm.g === cl.g && cm.b === cl.b).toBe(false);
  });
});
