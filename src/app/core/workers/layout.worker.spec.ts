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
  return { path, isFile: true, fileSize, subtreeFiles: 1, subtreeBytes: fileSize, children: [] };
}

function makeFolder(path: string, subtreeFiles: number, children: TreeStructure[]): TreeStructure {
  const subtreeBytes = children.reduce((s, c) => s + c.subtreeBytes, 0);
  return { path, isFile: false, subtreeFiles, subtreeBytes, children };
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
    const nodes = layoutTree(makeFolder('', 0, []), PARAMS);
    const root  = byPath(nodes, '');
    expect(root.x).toBe(0);
    expect(root.y).toBe(0);
    expect(root.z).toBe(0);
  });

  it('does not throw on empty root', () => {
    expect(() => layoutTree(makeFolder('', 1, []), PARAMS)).not.toThrow();
  });

  it('returns a flat array — no node has children', () => {
    const tree  = makeFolder('', 3, [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')]);
    const nodes = layoutTree(tree, PARAMS);
    for (const n of nodes) expect((n as any).children).toBeUndefined();
  });

  it('does not mutate the input TreeStructure', () => {
    const file   = makeFile('a.ts');
    const input  = makeFolder('', 1, [file]);
    layoutTree(input, PARAMS);
    expect((input as any).x).toBeUndefined();
    expect((file  as any).x).toBeUndefined();
  });

  it('places files on a Fibonacci sphere of radius cloudR around parent', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')];
    const nodes = layoutTree(makeFolder('', 3, files), PARAMS);
    const root  = byPath(nodes, '');
    const cloudR = (PARAMS.dotD / 2) * Math.sqrt(files.length);
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      const f    = byPath(nodes, name);
      const dist = Math.sqrt((f.x - root.x) ** 2 + (f.y - root.y) ** 2 + (f.z - root.z) ** 2);
      expect(dist).toBeCloseTo(cloudR, 5);
    }
  });

  it('folder connectionWidth is in [2, 12]', () => {
    const tree  = makeFolder('', 2, [makeFolder('src', 2, [makeFile('src/a.ts'), makeFile('src/b.ts')])]);
    const nodes = layoutTree(tree, PARAMS);
    const src   = byPath(nodes, 'src');
    expect(src.connectionWidth).toBeGreaterThanOrEqual(2);
    expect(src.connectionWidth).toBeLessThanOrEqual(12);
  });

  it('folder nodeSize is at least 5', () => {
    const tree  = makeFolder('', 1, [makeFolder('src', 1, [makeFile('src/a.ts')])]);
    const nodes = layoutTree(tree, PARAMS);
    expect(byPath(nodes, 'src').nodeSize).toBeGreaterThanOrEqual(5);
  });

  it('file nodeSize is at least 1.5', () => {
    const nodes = layoutTree(makeFolder('', 1, [makeFile('a.ts', 500)]), PARAMS);
    expect(byPath(nodes, 'a.ts').nodeSize).toBeGreaterThanOrEqual(1.5);
  });

  it('file nodeSize is larger for a bigger file', () => {
    const tree  = makeFolder('', 2, [makeFile('small.ts', 10), makeFile('large.ts', 100_000)]);
    const nodes = layoutTree(tree, PARAMS);
    expect(byPath(nodes, 'large.ts').nodeSize).toBeGreaterThan(byPath(nodes, 'small.ts').nodeSize);
  });

  it('single subfolder is placed at non-zero distance from root', () => {
    const tree  = makeFolder('', 1, [makeFolder('src', 1, [makeFile('src/a.ts')])]);
    const nodes = layoutTree(tree, PARAMS);
    const src   = byPath(nodes, 'src');
    expect(Math.sqrt(src.x ** 2 + src.y ** 2 + src.z ** 2)).toBeGreaterThan(0);
  });

  it('deeper folders have greater z than their parent', () => {
    const tree  = makeFolder('', 1, [makeFolder('a', 1, [makeFolder('a/b', 1, [makeFile('a/b/x.ts')])])]);
    const nodes = layoutTree(tree, PARAMS);
    const root  = byPath(nodes, '');
    const mid   = byPath(nodes, 'a');
    const deep  = byPath(nodes, 'a/b');
    expect(mid.z).toBeGreaterThan(root.z);
    expect(deep.z).toBeGreaterThan(mid.z);
  });

  it('files have connectionWidth of 0', () => {
    const nodes = layoutTree(makeFolder('', 1, [makeFile('readme.md', 200)]), PARAMS);
    expect(byPath(nodes, 'readme.md').connectionWidth).toBe(0);
  });

  it('handles large N of siblings without throwing (spread-operator overflow guard)', () => {
    const children = Array.from({ length: 300 }, (_, i) =>
      makeFolder(`dir${i}`, 1, [makeFile(`dir${i}/f.ts`)]),
    );
    expect(() => layoutTree(makeFolder('', 300, children), PARAMS)).not.toThrow();
  });
});
