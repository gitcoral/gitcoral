/// <reference lib="webworker" />

import { LayoutParams, PositionedNode, TreeStructure, WorkerRequest, WorkerResponse } from '../../shared/models/tree-node.model';

// ---------------------------------------------------------------------------
// Physics simulation — places sibling folders on a unit sphere
// ---------------------------------------------------------------------------

export function simulate(weights: number[], buoy: number, repel: number): Array<[number, number]> {
  const N = weights.length;
  if (N === 0) return [];
  if (N === 1) return [[0.0, 0.0]];

  const maxW = weights.reduce((m, v) => v > m ? v : m, 0);
  const thetas = new Float64Array(N).fill(Math.PI / 3);
  const phis   = Float64Array.from({ length: N }, (_, i) => i * 2 * Math.PI / N);

  // Pre-allocate reusable buffers — no per-step heap allocation
  const px  = new Float64Array(N);
  const py  = new Float64Array(N);
  const pz  = new Float64Array(N);
  const dt  = new Float64Array(N);
  const dp  = new Float64Array(N);
  const sq  = new Float64Array(N); // sqrt(w/maxW) per node
  for (let i = 0; i < N; i++) sq[i] = Math.sqrt(weights[i] / maxW);

  const LR           = 0.05;
  const MAX_STEPS    = 200;
  const CONVERGE_EPS = 1e-4; // early exit when forces are negligible

  for (let step = 0; step < MAX_STEPS; step++) {
    const lr = LR * (1 - 0.5 * step / MAX_STEPS);

    // Update positions in flat typed arrays
    for (let i = 0; i < N; i++) {
      const st = Math.sin(thetas[i]);
      px[i] = st * Math.cos(phis[i]);
      py[i] = st * Math.sin(phis[i]);
      pz[i] = Math.cos(thetas[i]);
    }

    dt.fill(0);
    dp.fill(0);

    let maxForce = 0;
    for (let i = 0; i < N; i++) {
      const t   = thetas[i];
      const p   = phis[i];
      const ct  = Math.cos(t);
      const st  = Math.sin(t);
      const cp  = Math.cos(p);
      const sp  = Math.sin(p);
      // Tangent basis
      const etx =  ct * cp;  const ety =  ct * sp;  const etz = -st;
      const epx = -sp;        const epy =  cp;

      // Buoyancy
      dt[i] -= buoy * sq[i];

      // Coulomb repulsion
      const qi = sq[i];
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const dx = px[i] - px[j];
        const dy = py[i] - py[j];
        const dz = pz[i] - pz[j];
        const d2 = Math.max(dx * dx + dy * dy + dz * dz, 0.01);
        const s  = repel * qi * sq[j] / d2;
        dt[i] += s * (dx * etx + dy * ety + dz * etz);
        dp[i] += s * (dx * epx + dy * epy);
      }
      maxForce = Math.max(maxForce, Math.abs(dt[i]), Math.abs(dp[i]));
    }

    for (let i = 0; i < N; i++) {
      thetas[i] = Math.max(1e-6, Math.min(Math.PI * 5 / 12, thetas[i] + lr * dt[i]));
      phis[i]   = ((phis[i] + lr * dp[i]) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    }

    if (maxForce * lr < CONVERGE_EPS) break; // converged early
  }

  const EPS = 1e-9;
  return Array.from({ length: N }, (_, i) => [
    thetas[i],
    // Snap to nearest multiple of π when already effectively there — avoids floating-point drift
    Math.abs(Math.sin(phis[i])) > EPS ? phis[i] : Math.round(phis[i] / Math.PI) * Math.PI,
  ]);
}

// ---------------------------------------------------------------------------
// Layout — top-down recursive placement
// ---------------------------------------------------------------------------

// Internal working type: TreeStructure fields + all spatial fields pre-initialised.
// Built by toLayoutNode() before placement begins — the input TreeStructure is never mutated.
interface LayoutNode {
  path: string;
  isFile: boolean;
  fileSize?: number;
  subtreeFiles: number;
  subtreeBytes: number;
  children: LayoutNode[];
  x: number;
  y: number;
  z: number;
  connectionWidth: number;
  nodeSize: number;
}

const GOLDEN_F = Math.PI * (3 - Math.sqrt(5)); // golden-angle step for Fibonacci sphere
const SNAP     = 1e-10;                         // snap near-zero coords to exact zero

function toLayoutNode(src: TreeStructure): LayoutNode {
  return {
    path: src.path,
    isFile: src.isFile,
    fileSize: src.fileSize,
    subtreeFiles: src.subtreeFiles,
    subtreeBytes: src.subtreeBytes,
    children: src.children.map(toLayoutNode),
    x: 0, y: 0, z: 0,
    connectionWidth: 0,
    nodeSize: 0,
  };
}

function flattenLayoutTree(root: LayoutNode): PositionedNode[] {
  const result: PositionedNode[] = [];
  const stack: LayoutNode[]      = [root];
  while (stack.length) {
    const { children, ...node } = stack.pop()!;
    result.push(node);
    stack.push(...children);
  }
  return result;
}

// Takes a TreeStructure, returns a flat PositionedNode[] ready for the renderer.
export function layoutTree(root: TreeStructure, params: LayoutParams): PositionedNode[] {
  const { layerHeight, zScale, buoyancy, repulsion, decay, dotD } = params;

  const layoutRoot  = toLayoutNode(root);
  const maxSubtree  = layoutRoot.subtreeFiles ?? 1;
  const maxFileSize = maxFileSizeInTree(layoutRoot);

  function place(n: LayoutNode, hintAngle: number, conn: number): void {
    const px = n.x, py = n.y, pz = n.z;

    const folders = n.children
      .filter(c => !c.isFile)
      .sort((a, b) => b.subtreeFiles - a.subtreeFiles);

    const coords = simulate(folders.map(f => f.subtreeFiles), buoyancy, repulsion);
    const maxSf  = folders.reduce((m, f) => Math.max(m, f.subtreeFiles), 1);

    for (let i = 0; i < folders.length; i++) {
      const sf = folders[i];
      const [theta, phi] = coords[i];
      const phiG = (phi + hintAngle) % (2 * Math.PI);

      const scale     = 0.3 + 0.7 * Math.log1p(sf.subtreeFiles) / Math.log1p(maxSf);
      const childConn = conn * scale;
      const r = childConn * Math.sin(theta);
      const h = childConn * Math.cos(theta);

      const x = px + r * Math.cos(phiG);
      const y = py + r * Math.sin(phiG);

      sf.x = Math.abs(x) < SNAP ? 0 : x;
      sf.y = Math.abs(y) < SNAP ? 0 : y;
      sf.z = pz + h * zScale;

      // connectionWidth: log-normalised subtree weight × depth penalty → 6 visual buckets.
      // Stepped (not continuous) so Plotly edge-batching produces fewer distinct trace widths.
      const depth     = sf.path.split('/').length;
      const tSubtree  = Math.log1p(sf.subtreeFiles) / Math.log1p(maxSubtree);
      const tDepth    = 1 / Math.sqrt(depth + 1);
      const t         = tSubtree * tDepth;
      const N_BUCKETS = 6;
      const bucket    = Math.min(N_BUCKETS - 1, Math.floor(t * N_BUCKETS));
      sf.connectionWidth = 2 + (12 - 2) * bucket / (N_BUCKETS - 1);

      // nodeSize: log-compressed subtree count
      sf.nodeSize = Math.max(5, 5 + 4 * Math.min(2, Math.log1p(sf.subtreeFiles)));

      // h * decay: vertical displacement of this node becomes the sphere radius for its
      // children — tighter sphere the deeper we go, floored to avoid vanishing connectors.
      const nextSphereRadius = Math.max(h * decay, layerHeight * 0.15);
      place(sf, phiG, nextSphereRadius);
    }

    // Files — Fibonacci sphere cloud, radius scales with √N to keep visual density stable
    const files = n.children.filter(c => c.isFile);
    const Nf    = files.length;
    if (Nf > 0) {
      const cloudR = (dotD / 2) * Math.sqrt(Nf);
      for (let i = 0; i < Nf; i++) {
        const f    = files[i];
        const cosT = 1 - (2 * i + 1) / Nf;
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const phiF = i * GOLDEN_F;
        f.x = px + cloudR * sinT * Math.cos(phiF);
        f.y = py + cloudR * sinT * Math.sin(phiF);
        f.z = pz + cloudR * cosT;

        const sz = f.fileSize ?? 0;
        f.nodeSize        = 1.5 + 4.5 * Math.log1p(sz) / Math.log1p(Math.max(maxFileSize, 1));
        f.connectionWidth = 0; // files have no connector
      }
    }
  }

  place(layoutRoot, 0, layerHeight);
  return flattenLayoutTree(layoutRoot);
}

function maxFileSizeInTree(node: LayoutNode): number {
  let max = 0;
  const stack: LayoutNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.isFile && (n.fileSize ?? 0) > max) max = n.fileSize!;
    stack.push(...n.children);
  }
  return max;
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    const response: WorkerResponse = {
      result: {
        nodes: layoutTree(data.root, data.params),
        repoName: data.repoName,
      },
    };
    postMessage(response);
  } catch (e) {
    const response: WorkerResponse = {
      result: { nodes: [], repoName: data.repoName },
      error: e instanceof Error ? e.message : String(e),
    };
    postMessage(response);
  }
});
