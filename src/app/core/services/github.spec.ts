import { TestBed } from '@angular/core/testing';
import { describe, beforeEach, it, expect } from 'vitest';
import { GithubService } from './github';

describe('GithubService', () => {
  let service: GithubService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(GithubService);
  });

  // -------------------------------------------------------------------------
  // parseRepoUrl
  // -------------------------------------------------------------------------

  describe('parseRepoUrl', () => {
    it('parses SSH URL with .git', () => {
      expect(service.parseRepoUrl('git@github.com:owner/repo.git'))
        .toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('parses SSH URL without .git', () => {
      expect(service.parseRepoUrl('git@github.com:owner/repo'))
        .toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('parses HTTPS URL', () => {
      expect(service.parseRepoUrl('https://github.com/owner/repo'))
        .toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('parses HTTPS URL with .git suffix', () => {
      expect(service.parseRepoUrl('https://github.com/owner/repo.git'))
        .toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('parses HTTPS URL with trailing slash', () => {
      expect(service.parseRepoUrl('https://github.com/owner/repo/'))
        .toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('parses github.com URL without scheme', () => {
      expect(service.parseRepoUrl('github.com/owner/repo'))
        .toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('parses short owner/repo form', () => {
      expect(service.parseRepoUrl('owner/repo'))
        .toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('returns null for a bare name with no slash', () => {
      expect(service.parseRepoUrl('just-a-name')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(service.parseRepoUrl('')).toBeNull();
    });

    it('returns null for a random URL with no owner/repo path', () => {
      expect(service.parseRepoUrl('https://example.com')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // computeSubtreeFiles (private — accessed via cast)
  // -------------------------------------------------------------------------

  describe('computeSubtreeStats', () => {
    const svc = () => service as any;

    it('sets subtreeBytes to fileSize for a file node', () => {
      const file = svc().makeNode('a.ts', true, 100);
      svc().computeSubtreeStats(file);
      expect(file.subtreeBytes).toBe(100);
    });

    it('sums direct file children', () => {
      const root = svc().makeNode('', false);
      root.children.set('a.ts', svc().makeNode('a.ts', true, 10));
      root.children.set('b.ts', svc().makeNode('b.ts', true, 20));
      svc().computeSubtreeStats(root);
      expect(root.subtreeBytes).toBe(30);
    });

    it('sums recursively through nested folders', () => {
      const child = svc().makeNode('src', false);
      child.children.set('x.ts', svc().makeNode('src/x.ts', true, 50));
      child.children.set('y.ts', svc().makeNode('src/y.ts', true, 50));
      const root = svc().makeNode('', false);
      root.children.set('src', child);
      svc().computeSubtreeStats(root);
      expect(root.subtreeBytes).toBe(100);
    });

    it('empty folder has subtreeBytes of 0', () => {
      const empty = svc().makeNode('empty', false);
      svc().computeSubtreeStats(empty);
      expect(empty.subtreeBytes).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // ensurePath (private)
  // -------------------------------------------------------------------------

  describe('ensurePath', () => {
    const svc = () => service as any;

    it('creates a deeply nested hierarchy', () => {
      const root = svc().makeNode('', false);
      svc().ensurePath(root, 'a/b/c.ts', true, 42);

      const a = root.children.get('a');
      expect(a).toBeTruthy();
      const b = a.children.get('b');
      expect(b).toBeTruthy();
      const leaf = b.children.get('c.ts');
      expect(leaf.isFile).toBe(true);
      expect(leaf.fileSize).toBe(42);
    });

    it('sets path strings correctly', () => {
      const root = svc().makeNode('', false);
      svc().ensurePath(root, 'x/y.ts', true, 1);
      expect(root.children.get('x').path).toBe('x');
      expect(root.children.get('x').children.get('y.ts').path).toBe('x/y.ts');
    });

    it('updates isFile and fileSize when blob entry follows tree entry', () => {
      const root = svc().makeNode('', false);
      // Tree entry arrives first (GitHub API can send them out of order)
      svc().ensurePath(root, 'a/file.ts', false, 0);
      svc().ensurePath(root, 'a/file.ts', true, 999);
      const leaf = root.children.get('a').children.get('file.ts');
      expect(leaf.isFile).toBe(true);
      expect(leaf.fileSize).toBe(999);
    });

    it('reuses existing intermediate nodes on shared prefixes', () => {
      const root = svc().makeNode('', false);
      svc().ensurePath(root, 'src/a.ts', true, 1);
      svc().ensurePath(root, 'src/b.ts', true, 2);
      // Only one 'src' folder should exist
      expect(root.children.size).toBe(1);
      expect(root.children.get('src').children.size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // toTreeNode (private)
  // -------------------------------------------------------------------------

  describe('toTreeNode', () => {
    const svc = () => service as any;

    it('preserves path, isFile, fileSize and subtreeBytes', () => {
      const internal = svc().makeNode('src/app.ts', true, 512);
      internal.subtreeBytes = 512;
      const node = svc().toTreeNode(internal);
      expect(node.path).toBe('src/app.ts');
      expect(node.isFile).toBe(true);
      expect(node.fileSize).toBe(512);
      expect(node.subtreeBytes).toBe(512);
    });

    it('does not include layout fields', () => {
      const internal = svc().makeNode('src/app.ts', true, 512);
      const node = svc().toTreeNode(internal);
      expect((node as any).x).toBeUndefined();
      expect((node as any).y).toBeUndefined();
      expect((node as any).z).toBeUndefined();
      expect((node as any).connectionWidth).toBeUndefined();
      expect((node as any).nodeSize).toBeUndefined();
    });

    it('omits fileSize for folders', () => {
      const internal = svc().makeNode('src', false, 0);
      const node = svc().toTreeNode(internal);
      expect(node.fileSize).toBeUndefined();
    });

    it('converts children map to children array', () => {
      const parent = svc().makeNode('src', false, 0);
      parent.children.set('a.ts', svc().makeNode('src/a.ts', true, 10));
      parent.children.set('b.ts', svc().makeNode('src/b.ts', true, 20));
      const node = svc().toTreeNode(parent);
      expect(Array.isArray(node.children)).toBe(true);
      expect(node.children).toHaveLength(2);
    });
  });
});
