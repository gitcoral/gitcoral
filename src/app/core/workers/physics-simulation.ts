// Places N sibling folders on a unit sphere via buoyancy + Coulomb repulsion.
// Returns [theta, phi] for each node (spherical coordinates).
export function simulate(weights: number[], buoy: number, repel: number): Array<[number, number]> {
  const N = weights.length;
  if (N === 0) return [];
  if (N === 1) return [[0.0, 0.0]];

  const maxW = weights.reduce((m, v) => (v > m ? v : m), 0);
  const thetas = new Float64Array(N).fill(Math.PI / 3);
  const phis = Float64Array.from({ length: N }, (_, i) => (i * 2 * Math.PI) / N);

  // Pre-allocate reusable buffers — no per-step heap allocation
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const pz = new Float64Array(N);
  const dt = new Float64Array(N);
  const dp = new Float64Array(N);
  const sq = new Float64Array(N); // sqrt(w/maxW) per node
  const sqDenom = maxW || 1; // guard: all-zero weights would produce 0/0 = NaN
  for (let i = 0; i < N; i++) sq[i] = Math.sqrt(weights[i] / sqDenom);

  const LR = 0.05;
  const MAX_STEPS = 200;
  const CONVERGE_EPS = 1e-4; // early exit when forces are negligible

  for (let step = 0; step < MAX_STEPS; step++) {
    const lr = LR * (1 - (0.5 * step) / MAX_STEPS);

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
      const t = thetas[i];
      const p = phis[i];
      const ct = Math.cos(t);
      const st = Math.sin(t);
      const cp = Math.cos(p);
      const sp = Math.sin(p);
      // Tangent basis
      const etx = ct * cp;
      const ety = ct * sp;
      const etz = -st;
      const epx = -sp;
      const epy = cp;

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
        const s = (repel * qi * sq[j]) / d2;
        dt[i] += s * (dx * etx + dy * ety + dz * etz);
        dp[i] += s * (dx * epx + dy * epy);
      }
      maxForce = Math.max(maxForce, Math.abs(dt[i]), Math.abs(dp[i]));
    }

    for (let i = 0; i < N; i++) {
      thetas[i] = Math.max(1e-6, Math.min((Math.PI * 5) / 12, thetas[i] + lr * dt[i]));
      phis[i] = (((phis[i] + lr * dp[i]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
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
