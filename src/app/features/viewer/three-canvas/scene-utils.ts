import { PositionedNode } from '../../../shared/models/tree-node.model';

export function fileExt(path: string): string {
  const filename = path.slice(path.lastIndexOf('/') + 1);
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function hashPath(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (Math.imul(31, h) + path.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.substring(0, i) : '';
}

export function makeCbrtNormalizer(
  values: number[],
  outMin: number,
  outMax: number,
): (v: number) => number {
  const cbrtValues = values.map((v) => Math.cbrt(v));
  const min = Math.min(...cbrtValues, 0);
  const max = Math.max(...cbrtValues, 1);
  const range = max - min || 1;
  return (v: number) => outMin + ((outMax - outMin) * (Math.cbrt(v) - min)) / range;
}

// Returns the set of paths that should remain fully visible when focusPath is selected:
// the focused node itself, all its ancestors, and all its descendants.
export function buildFocusSet(nodes: PositionedNode[], focusPath: string): Set<string> {
  const set = new Set<string>();
  set.add(focusPath);
  const parts = focusPath.split('/');
  for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
  set.add('');
  const prefix = focusPath ? focusPath + '/' : '';
  for (const n of nodes) {
    if (prefix === '' || n.path.startsWith(prefix)) set.add(n.path);
  }
  return set;
}
