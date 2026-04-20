import { describe, expect, it } from 'vitest';
import { simulate } from './physics-simulation';

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
