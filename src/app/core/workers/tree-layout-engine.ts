import {
  DiffStatus,
  LayoutParams,
  PositionedNode,
  TreeStructure,
} from '../../shared/models/tree-node.model';
import { simulate } from './physics-simulation';

// Internal working type: TreeStructure fields + all spatial fields pre-initialised.
// Built by toLayoutNode() before placement begins — the input TreeStructure is never mutated.
interface LayoutNode {
  path: string;
  isFile: boolean;
  fileSize?: number;
  subtreeBytes: number;
  sha?: string;
  diffStatus?: DiffStatus;
  children: LayoutNode[];
  x: number;
  y: number;
  z: number;
  connectionWidth: number;
}

const GOLDEN_F = Math.PI * (3 - Math.sqrt(5)); // golden-angle step for Fibonacci sphere
const SNAP = 1e-10; // snap near-zero coords to exact zero

function toLayoutNode(src: TreeStructure): LayoutNode {
  return {
    path: src.path,
    isFile: src.isFile,
    fileSize: src.fileSize,
    subtreeBytes: src.subtreeBytes,
    sha: src.sha,
    diffStatus: src.diffStatus,
    children: src.children.map(toLayoutNode),
    x: 0,
    y: 0,
    z: 0,
    connectionWidth: 0,
  };
}

function flattenLayoutTree(root: LayoutNode): PositionedNode[] {
  const result: PositionedNode[] = [];
  const stack: LayoutNode[] = [root];
  while (stack.length) {
    const { children, ...node } = stack.pop()!;
    result.push(node);
    stack.push(...children);
  }
  return result;
}

function maxFileCbrtInTree(node: LayoutNode): number {
  let max = 0;
  const stack: LayoutNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.isFile) max = Math.max(max, Math.cbrt(n.fileSize ?? 0));
    stack.push(...n.children);
  }
  return max;
}

// Takes a TreeStructure, returns a flat PositionedNode[] ready for the renderer.
export function layoutTree(root: TreeStructure, params: LayoutParams): PositionedNode[] {
  const { layerHeight, zScale, buoyancy, repulsion, spread, sphereD } = params;

  const layoutRoot = toLayoutNode(root);
  const maxSubtreeCbrt = Math.cbrt(layoutRoot.subtreeBytes);
  const maxFileCbrt = maxFileCbrtInTree(layoutRoot);

  function place(n: LayoutNode, hintAngle: number, conn: number): void {
    const px = n.x,
      py = n.y,
      pz = n.z;

    const folders = n.children
      .filter((c) => !c.isFile)
      .sort((a, b) => b.subtreeBytes - a.subtreeBytes);

    const coords = simulate(
      folders.map((f) => f.subtreeBytes),
      buoyancy,
      repulsion,
    );

    for (let i = 0; i < folders.length; i++) {
      const sf = folders[i];
      const [theta, phi] = coords[i];
      const phiG = (phi + hintAngle) % (2 * Math.PI);

      const r = conn * Math.sin(theta);
      const h = conn * Math.cos(theta);

      const x = px + r * Math.cos(phiG);
      const y = py + r * Math.sin(phiG);

      sf.x = Math.abs(x) < SNAP ? 0 : x;
      sf.y = Math.abs(y) < SNAP ? 0 : y;
      sf.z = pz + h * zScale;

      // connectionWidth: cbrt-normalised subtreeBytes → 6 visual buckets.
      // Stepped (not continuous) so edge-batching produces fewer distinct LineMaterial instances.
      const t = Math.cbrt(sf.subtreeBytes) / maxSubtreeCbrt;
      const N_BUCKETS = 6;
      const bucket = Math.min(N_BUCKETS - 1, Math.floor(t * N_BUCKETS));
      sf.connectionWidth = 2 + ((12 - 2) * bucket) / (N_BUCKETS - 1);

      // h * spread: vertical displacement of this node becomes the sphere radius for its
      // children — tighter sphere the deeper we go, floored to avoid vanishing connectors.
      const nextSphereRadius = Math.max(h * spread, layerHeight * 0.15);
      place(sf, phiG, nextSphereRadius);
    }

    // Files — Fibonacci sphere cloud, radius scales with √N and average file size
    const files = n.children.filter((c) => c.isFile);
    const Nf = files.length;
    if (Nf > 0) {
      const avgFileCbrt = files.reduce((s, f) => s + Math.cbrt(f.fileSize ?? 0), 0) / Nf;
      const sizeScale = maxFileCbrt > 0 ? avgFileCbrt / maxFileCbrt : 0;
      const cloudR = (sphereD / 2) * Math.sqrt(Nf) * (1 + sizeScale);
      for (let i = 0; i < Nf; i++) {
        const f = files[i];
        const cosT = 1 - (2 * i + 1) / Nf;
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const phiF = i * GOLDEN_F;
        f.x = px + cloudR * sinT * Math.cos(phiF);
        f.y = py + cloudR * sinT * Math.sin(phiF);
        f.z = pz + cloudR * cosT;

        f.connectionWidth = 0; // files have no connector
      }
    }
  }

  place(layoutRoot, 0, layerHeight);
  return flattenLayoutTree(layoutRoot);
}
