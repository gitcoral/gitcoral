import { describe, expect, it } from 'vitest';
import { layoutTree } from './tree-layout-engine';
import { LayoutParams, PositionedNode, TreeStructure } from '../../shared/models/tree-node.model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARAMS: LayoutParams = {
  layerHeight: 2.0,
  zScale: 0.6,
  buoyancy: 3.0,
  repulsion: 1.5,
  spread: 0.8,
  sphereD: 0.02,
};

function makeFile(path: string, fileSize = 100): TreeStructure {
  return { path, isFile: true, fileSize, subtreeBytes: fileSize, children: [] };
}

function makeFolder(path: string, children: TreeStructure[]): TreeStructure {
  const subtreeBytes = children.reduce((s, c) => s + c.subtreeBytes, 0);
  return { path, isFile: false, subtreeBytes, children };
}

function byPath(nodes: PositionedNode[], path: string): PositionedNode {
  const n = nodes.find((n) => n.path === path);
  if (!n) throw new Error(`node not found: "${path}"`);
  return n;
}

// ---------------------------------------------------------------------------
// layoutTree()
// ---------------------------------------------------------------------------

describe('layoutTree', () => {
  it('places root at origin', () => {
    const nodes = layoutTree(makeFolder('', []), PARAMS);
    const root = byPath(nodes, '');
    expect(root.x).toBe(0);
    expect(root.y).toBe(0);
    expect(root.z).toBe(0);
  });

  it('does not throw on empty root', () => {
    expect(() => layoutTree(makeFolder('', []), PARAMS)).not.toThrow();
  });

  it('returns a flat array — no node has children', () => {
    const tree = makeFolder('', [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')]);
    const nodes = layoutTree(tree, PARAMS);
    for (const n of nodes) expect((n as any).children).toBeUndefined();
  });

  it('does not mutate the input TreeStructure', () => {
    const file = makeFile('a.ts');
    const input = makeFolder('', [file]);
    layoutTree(input, PARAMS);
    expect((input as any).x).toBeUndefined();
    expect((file as any).x).toBeUndefined();
  });

  it('places files on a Fibonacci sphere of radius cloudR around parent', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')];
    const nodes = layoutTree(makeFolder('', files), PARAMS);
    const root = byPath(nodes, '');
    // All files share the same cloudR — verify they are equidistant from parent
    const dists = ['a.ts', 'b.ts', 'c.ts'].map((name) => {
      const f = byPath(nodes, name);
      return Math.sqrt((f.x - root.x) ** 2 + (f.y - root.y) ** 2 + (f.z - root.z) ** 2);
    });
    for (const d of dists) expect(d).toBeCloseTo(dists[0], 5);
  });

  it('folder connectionWidth is in [2, 12]', () => {
    const tree = makeFolder('', [makeFolder('src', [makeFile('src/a.ts'), makeFile('src/b.ts')])]);
    const nodes = layoutTree(tree, PARAMS);
    const src = byPath(nodes, 'src');
    expect(src.connectionWidth).toBeGreaterThanOrEqual(2);
    expect(src.connectionWidth).toBeLessThanOrEqual(12);
  });

  it('single subfolder is placed at non-zero distance from root', () => {
    const tree = makeFolder('', [makeFolder('src', [makeFile('src/a.ts')])]);
    const nodes = layoutTree(tree, PARAMS);
    const src = byPath(nodes, 'src');
    expect(Math.sqrt(src.x ** 2 + src.y ** 2 + src.z ** 2)).toBeGreaterThan(0);
  });

  it('deeper folders have greater z than their parent', () => {
    const tree = makeFolder('', [makeFolder('a', [makeFolder('a/b', [makeFile('a/b/x.ts')])])]);
    const nodes = layoutTree(tree, PARAMS);
    const root = byPath(nodes, '');
    const mid = byPath(nodes, 'a');
    const deep = byPath(nodes, 'a/b');
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
