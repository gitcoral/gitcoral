import { describe, expect, it } from 'vitest';
import { simulate, layoutTree } from './layout.worker';
import { LayoutParams, PositionedNode, TreeStructure } from '../../shared/models/tree-node.model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARAMS: LayoutParams = {
  layerHeight: 2.0,
  zScale: 0.5,
  buoyancy: 2.0,
  repulsion: 1.5,
  decay: 0.82,
  dotD: 0.02,
};

function makeFile(path: string, fileSize = 100): TreeStructure {
  return { path, isFile: true, fileSize, subtreeBytes: fileSize, children: [] };
}

function makeFolder(path: string, children: TreeStructure[]): TreeStructure {
  const subtreeBytes = children.reduce((s, c) => s + c.subtreeBytes, 0);
  return { path, isFile: false, subtreeBytes, children };
}

function byPath(nodes: PositionedNode[], path: string): PositionedNode {
  const n = nodes.find(n => n.path === path);
  if (!n) throw new Error(`node not found: "${path}"`);
  return n;
}

// ---------------------------------------------------------------------------
// simulate()
// ---------------------------------------------------------------------------

describe('simulate', () => {
  it('returns [] for N=0', () => {
    expect(simulate([], 2, 1.5)).toEqual([]);
  });

  it('returns [[0, 0]] for N=1', () => {
    expect(simulate([1], 2, 1.5)).toEqual([[0, 0]]);
  });

  it('returns one entry per weight', () => {
    expect(simulate([1, 2, 3], 2, 1.5)).toHaveLength(3);
  });

  it('all thetas within clamped range [1e-6, π·5/12]', () => {
    const result = simulate([1, 2, 3, 5, 8], 2, 1.5);
    for (const [theta] of result) {
      expect(theta).toBeGreaterThanOrEqual(1e-6);
      expect(theta).toBeLessThanOrEqual(Math.PI * 5 / 12);
    }
  });

  it('all phis within [0, 2π)', () => {
    const result = simulate([1, 2, 3, 5, 8], 2, 1.5);
    for (const [, phi] of result) {
      expect(phi).toBeGreaterThanOrEqual(0);
      expect(phi).toBeLessThan(2 * Math.PI);
    }
  });

  it('two equal-weight nodes end up roughly π apart in phi', () => {
    // Use zero buoyancy so nodes spread purely laterally
    const [[, phi0], [, phi1]] = simulate([1, 1], 0, 3);
    const diff = Math.abs(phi1 - phi0);
    const wrapped = Math.min(diff, 2 * Math.PI - diff);
    expect(wrapped).toBeCloseTo(Math.PI, 0);
  });

  it('with zero repulsion all nodes converge to minimum theta (buoyancy dominates)', () => {
    const result = simulate([1, 2, 3], 10, 0);
    for (const [theta] of result) {
      expect(theta).toBeCloseTo(1e-6, 3);
    }
  });

  it('heavier node has lower or equal theta than lighter node under strong buoyancy', () => {
    const [[tHeavy], [tLight]] = simulate([100, 1], 10, 0);
    expect(tHeavy).toBeLessThanOrEqual(tLight + 1e-6);
  });

  it('handles large N without throwing (spread-operator overflow guard)', () => {
    const weights = Array.from({ length: 500 }, (_, i) => i + 1);
    expect(() => simulate(weights, 2, 1.5)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// layoutTree()
// ---------------------------------------------------------------------------

describe('layoutTree', () => {
  it('places root at origin', () => {
    const nodes = layoutTree(makeFolder('', []), PARAMS);
    const root  = byPath(nodes, '');
    expect(root.x).toBe(0);
    expect(root.y).toBe(0);
    expect(root.z).toBe(0);
  });

  it('does not throw on empty root', () => {
    expect(() => layoutTree(makeFolder('', []), PARAMS)).not.toThrow();
  });

  it('returns a flat array — no node has children', () => {
    const tree  = makeFolder('', [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')]);
    const nodes = layoutTree(tree, PARAMS);
    for (const n of nodes) expect((n as any).children).toBeUndefined();
  });

  it('does not mutate the input TreeStructure', () => {
    const file   = makeFile('a.ts');
    const input  = makeFolder('', [file]);
    layoutTree(input, PARAMS);
    expect((input as any).x).toBeUndefined();
    expect((file  as any).x).toBeUndefined();
  });

  it('places files on a Fibonacci sphere of radius cloudR around parent', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')];
    const nodes = layoutTree(makeFolder('', files), PARAMS);
    const root  = byPath(nodes, '');
    // All files share the same cloudR — verify they are equidistant from parent
    const dists = ['a.ts', 'b.ts', 'c.ts'].map(name => {
      const f = byPath(nodes, name);
      return Math.sqrt((f.x - root.x) ** 2 + (f.y - root.y) ** 2 + (f.z - root.z) ** 2);
    });
    for (const d of dists) expect(d).toBeCloseTo(dists[0], 5);
  });

  it('folder connectionWidth is in [2, 12]', () => {
    const tree  = makeFolder('', [makeFolder('src', [makeFile('src/a.ts'), makeFile('src/b.ts')])]);
    const nodes = layoutTree(tree, PARAMS);
    const src   = byPath(nodes, 'src');
    expect(src.connectionWidth).toBeGreaterThanOrEqual(2);
    expect(src.connectionWidth).toBeLessThanOrEqual(12);
  });

  it('single subfolder is placed at non-zero distance from root', () => {
    const tree  = makeFolder('', [makeFolder('src', [makeFile('src/a.ts')])]);
    const nodes = layoutTree(tree, PARAMS);
    const src   = byPath(nodes, 'src');
    expect(Math.sqrt(src.x ** 2 + src.y ** 2 + src.z ** 2)).toBeGreaterThan(0);
  });

  it('deeper folders have greater z than their parent', () => {
    const tree  = makeFolder('', [makeFolder('a', [makeFolder('a/b', [makeFile('a/b/x.ts')])])]);
    const nodes = layoutTree(tree, PARAMS);
    const root  = byPath(nodes, '');
    const mid   = byPath(nodes, 'a');
    const deep  = byPath(nodes, 'a/b');
    expect(mid.z).toBeGreaterThan(root.z);
    expect(deep.z).toBeGreaterThan(mid.z);
  });

  it('files have connectionWidth of 0', () => {
    const nodes = layoutTree(makeFolder('', [makeFile('readme.md', 200)]), PARAMS);
    expect(byPath(nodes, 'readme.md').connectionWidth).toBe(0);
  });

  it('handles large N of siblings without throwing (spread-operator overflow guard)', () => {
    const children = Array.from({ length: 300 }, (_, i) =>
      makeFolder(`dir${i}`, [makeFile(`dir${i}/f.ts`)]),
    );
    expect(() => layoutTree(makeFolder('', children), PARAMS)).not.toThrow();
  });
});
