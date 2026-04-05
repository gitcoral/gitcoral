/// <reference lib="webworker" />

import { LayoutParams, TreeNode, WorkerRequest, WorkerResponse } from '../../shared/models/tree-node.model';

// ---------------------------------------------------------------------------
// Physics simulation — places sibling folders on a unit sphere
// ---------------------------------------------------------------------------

function simulate(weights: number[], buoy: number, repel: number): Array<[number, number]> {
  const N = weights.length;
  if (N === 0) return [];
  if (N === 1) return [[0.0, 0.0]];

  const maxW = Math.max(...weights);
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
    Math.abs(Math.sin(phis[i])) > EPS ? phis[i] : Math.round(phis[i] / Math.PI) * Math.PI,
  ]);
}

// ---------------------------------------------------------------------------
// Layout — top-down recursive placement
// ---------------------------------------------------------------------------

function layoutTree(root: TreeNode, params: LayoutParams): void {
  const { layerHeight, zScale, buoyancy, repulsion, decay, dotD } = params;
  const GOLDEN_F = Math.PI * (3 - Math.sqrt(5));
  const SNAP = 1e-10;

  root.x = 0; root.y = 0; root.z = 0;

  // Pre-compute max subtree for nodeSize and connectionWidth normalisation
  const maxSubtree = root.subtreeFiles ?? 1;
  const maxFileSize = maxFileSizeInTree(root);

  function place(n: TreeNode, hintAngle: number, conn: number): void {
    const px = n.x, py = n.y, pz = n.z;

    const folders = (n.children ?? [])
      .filter(c => !c.isFile)
      .sort((a, b) => (b.subtreeFiles ?? 0) - (a.subtreeFiles ?? 0));

    const coords = simulate(folders.map(f => f.subtreeFiles ?? 1), buoyancy, repulsion);
    const maxSf  = Math.max(...folders.map(f => f.subtreeFiles ?? 1), 1);

    for (let i = 0; i < folders.length; i++) {
      const sf = folders[i];
      const [theta, phi] = coords[i];
      const phiG = (phi + hintAngle) % (2 * Math.PI);

      const scale     = 0.3 + 0.7 * Math.log1p(sf.subtreeFiles ?? 1) / Math.log1p(maxSf);
      const childConn = conn * scale;
      const r = childConn * Math.sin(theta);
      const h = childConn * Math.cos(theta);

      const x = px + r * Math.cos(phiG);
      const y = py + r * Math.sin(phiG);

      sf.x = Math.abs(x) < SNAP ? 0 : x;
      sf.y = Math.abs(y) < SNAP ? 0 : y;
      sf.z = pz + h * zScale;

      // connectionWidth: log-normalised subtree weight × depth decay → 6 buckets → px
      const depth      = sf.path.split('/').length;
      const tSubtree   = Math.log1p(sf.subtreeFiles ?? 1) / Math.log1p(maxSubtree);
      const tDepth     = 1 / Math.sqrt(depth + 1);
      const t          = tSubtree * tDepth;
      const N_BUCKETS  = 6;
      const bucket     = Math.min(N_BUCKETS - 1, Math.floor(t * N_BUCKETS));
      sf.connectionWidth = 2 + (12 - 2) * bucket / (N_BUCKETS - 1);

      // nodeSize: log-compressed subtree count
      sf.nodeSize = Math.max(5, 5 + 4 * Math.min(2, Math.log1p(sf.subtreeFiles ?? 1)));

      place(sf, phiG, Math.max(h * decay, layerHeight * 0.15));
    }

    // Files — Fibonacci sphere cloud, radius from sphere surface formula
    const files = (n.children ?? []).filter(c => c.isFile);
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

        // nodeSize: log-scaled file size
        const sz = f.fileSize ?? 0;
        f.nodeSize    = 1.5 + 4.5 * Math.log1p(sz) / Math.log1p(Math.max(maxFileSize, 1));
        f.connectionWidth = 0; // files have no connector
      }
    }
  }

  place(root, 0, layerHeight);
  fixOverlaps(root);
}

// ---------------------------------------------------------------------------
// Post-placement: bounding-sphere overlap correction
// ---------------------------------------------------------------------------

/** Bottom-up bounding radius: max 3-D distance from node to any descendant. */
function subtreeBoundingRadius(n: TreeNode, cache: Map<TreeNode, number>): number {
  let r = cache.get(n);
  if (r !== undefined) return r;
  r = 0;
  for (const c of (n.children ?? [])) {
    const cr  = subtreeBoundingRadius(c, cache);
    const dx  = c.x - n.x, dy = c.y - n.y, dz = c.z - n.z;
    const ext = Math.sqrt(dx * dx + dy * dy + dz * dz) + cr;
    if (ext > r) r = ext;
  }
  cache.set(n, r);
  return r;
}

/** Translate a whole subtree (root + all descendants) by (dx, dy, dz). */
function translateSubtree(n: TreeNode, dx: number, dy: number, dz: number): void {
  const stack: TreeNode[] = [n];
  while (stack.length) {
    const node = stack.pop()!;
    node.x += dx; node.y += dy; node.z += dz;
    if (node.children) stack.push(...node.children);
  }
}

/**
 * Push overlapping sibling subtrees radially away from their common parent
 * until no bounding spheres intersect. Runs up to MAX_PASSES iterations to
 * handle cascading corrections introduced by earlier fixes.
 *
 * Skips the root level (depth 0): top-level subtrees have bounding radii that
 * encompass the whole tree, so correcting them would push first connections to
 * extreme lengths. The physics sim already handles top-level angular separation.
 */
function fixOverlaps(root: TreeNode): void {
  const MAX_PASSES = 5;
  const MARGIN     = 1.05; // 5 % safety gap

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const cache = new Map<TreeNode, number>();
    let anyFix  = false;

    // BFS with depth tracking — parents before children
    const queue: Array<{ n: TreeNode; depth: number }> = [{ n: root, depth: 0 }];
    while (queue.length) {
      const { n, depth } = queue.shift()!;
      const folders = (n.children ?? []).filter(c => !c.isFile);

      // Skip the root level: its children's bounding spheres span the whole tree,
      // causing massive pushes that distort the first connections.
      if (depth > 0) {
        for (let i = 0; i < folders.length; i++) {
          for (let j = i + 1; j < folders.length; j++) {
            const ci = folders[i], cj = folders[j];
            const ri = subtreeBoundingRadius(ci, cache);
            const rj = subtreeBoundingRadius(cj, cache);
            const ex = ci.x - cj.x, ey = ci.y - cj.y, ez = ci.z - cj.z;
            const d  = Math.sqrt(ex * ex + ey * ey + ez * ez);
            const need = (ri + rj) * MARGIN;

            if (d < need) {
              // Radial direction from parent to each child
              const ix = ci.x - n.x, iy = ci.y - n.y, iz = ci.z - n.z;
              const di = Math.sqrt(ix * ix + iy * iy + iz * iz) || 1;
              const jx = cj.x - n.x, jy = cj.y - n.y, jz = cj.z - n.z;
              const dj = Math.sqrt(jx * jx + jy * jy + jz * jz) || 1;

              // Overshoot slightly (0.6 vs 0.5) to converge faster.
              // Cap at 50 % of child distance so corrections stay proportional.
              const push = Math.min((need - d) * 0.6, di * 0.5, dj * 0.5);
              translateSubtree(ci, ix / di * push, iy / di * push, iz / di * push);
              translateSubtree(cj, jx / dj * push, jy / dj * push, jz / dj * push);

              cache.clear(); // positions changed — invalidate all cached radii
              anyFix = true;
            }
          }
        }
      }

      for (const f of folders) queue.push({ n: f, depth: depth + 1 });
    }

    if (!anyFix) break;
  }
}

function maxFileSizeInTree(node: TreeNode): number {
  let max = 0;
  const stack: TreeNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.isFile && (n.fileSize ?? 0) > max) max = n.fileSize!;
    if (n.children) stack.push(...n.children);
  }
  return max;
}

// ---------------------------------------------------------------------------
// Flatten tree → flat array for transfer back to main thread
// ---------------------------------------------------------------------------

function flatten(root: TreeNode): TreeNode[] {
  const result: TreeNode[] = [];
  const stack: TreeNode[]  = [root];
  while (stack.length) {
    const n = stack.pop()!;
    // Strip children before sending — main thread only needs the flat list
    const { children, ...node } = n;
    result.push(node as TreeNode);
    if (children) stack.push(...children);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    layoutTree(data.root, data.params);
    const response: WorkerResponse = {
      result: {
        nodes: flatten(data.root),
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
