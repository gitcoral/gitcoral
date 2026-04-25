import { Component, DestroyRef, OnInit, ViewChild, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

import { GithubService } from '../../../core/services/github';
import { LayoutService } from '../../../core/services/layout';
import { ColorMode, DEFAULT_DISPLAY_OPTIONS, DEFAULT_LAYOUT_PARAMS, DisplayOptions, LayoutParams, LoadingState, TreeStructure } from '../../../shared/models/tree-node.model';
import { ControlsPanel, RepoSubmitEvent } from '../controls-panel/controls-panel';
import { ThreeCanvas } from '../three-canvas/three-canvas';

@Component({
  selector: 'app-viewer',
  imports: [ControlsPanel, ThreeCanvas],
  templateUrl: './viewer.html',
  styleUrl: './viewer.scss',
})
export class Viewer implements OnInit {

  @ViewChild(ThreeCanvas) private threeCanvas!: ThreeCanvas;

  resetCamera = false;
  display: DisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS };
  extColors: { ext: string; label: string; color: string; count: number }[] = [];
  status = signal<LoadingState>('idle');
  initialRepo = '';
  cameraParam: string | null = null;
  initialQuery = '';
  initialColorMode: ColorMode = 'type';

  get result() { return this.layout.result; }
  get error()  { return this.layout.error; }

  get maxFileSize(): number {
    const nodes = this.layout.result()?.nodes;
    if (!nodes) return 0;
    return Math.max(0, ...nodes.filter(n => n.isFile).map(n => n.fileSize ?? 0));
  }

  get maxDepth(): number {
    const nodes = this.layout.result()?.nodes;
    if (!nodes) return 0;
    return Math.max(0, ...nodes.map(n => n.path === '' ? 0 : n.path.split('/').length));
  }

  private rawRoot: TreeStructure | null = null;
  repoName = '';
  private params: LayoutParams = { ...DEFAULT_LAYOUT_PARAMS };
  private destroyRef = inject(DestroyRef);

  constructor(
    private github: GithubService,
    private layout: LayoutService,
    private router: Router,
    private route: ActivatedRoute,
  ) {
    // When layout finishes (result or error changes), go back to idle
    effect(() => {
      this.layout.result();
      this.layout.error();
      if (untracked(this.status) !== 'idle') this.status.set('idle');
    });
  }

  ngOnInit(): void {
    // React to route param changes — covers initial load and browser back/forward.
    // In ngOnInit (not constructor) so the view renders 'idle' before 'fetching' is set,
    // ensuring "Fetching…" is always visible on initial URL load.
    this.route.params.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      const { owner, repo } = params;
      if (owner && repo) {
        this.initialRepo = `${owner}/${repo}`;
        this.cameraParam = this.route.snapshot.queryParams['cam'] ?? null;
        const q = this.route.snapshot.queryParams['q'] ?? '';
        const color = this.route.snapshot.queryParams['color'] ?? '';
        this.initialQuery = q;
        this.initialColorMode = (['type', 'depth', 'size'] as ColorMode[]).includes(color as ColorMode)
          ? color as ColorMode : 'type';
        this.display = { ...DEFAULT_DISPLAY_OPTIONS, pathQuery: q, colorMode: this.initialColorMode };
        // Defer to next macrotask so Angular completes its initial render (status='idle')
        // before loadRepo sets status='fetching' — otherwise the fetching state is skipped.
        setTimeout(() => this.loadRepo(owner, repo));
      }
    });
  }

  async onRepoSubmit(event: RepoSubmitEvent): Promise<void> {
    this.layout.error.set(null);
    const parsed = this.github.parseRepoUrl(event.url);
    if (!parsed) { this.layout.error.set('Invalid GitHub URL'); return; }

    this.cameraParam = null;
    this.router.navigate([parsed.owner, parsed.repo], { replaceUrl: false });
    await this.loadRepo(parsed.owner, parsed.repo);
  }

  private async loadRepo(owner: string, repo: string): Promise<void> {
    this.status.set('fetching');
    try {
      this.rawRoot = await this.github.fetchTree(owner, repo);
      this.repoName = `${owner}/${repo}`;
      this.resetCamera = true;
      this.scheduleLayout();
    } catch (e) {
      this.layout.error.set(e instanceof Error ? e.message : String(e));
      this.status.set('idle');
    }
  }

  onDisplayChange(display: DisplayOptions): void {
    this.display = display;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q:     display.pathQuery  || null,
        color: display.colorMode !== 'type' ? display.colorMode : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  onCameraChange(cam: string): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { cam },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  onCameraReset(): void {
    this.threeCanvas.resetToDefaultCamera();
  }

  onSnapshot(): void {
    const filename = this.repoName
      ? `${this.repoName.replace('/', '-')}-snapshot.png`
      : 'gitcoral-snapshot.png';
    this.threeCanvas.takeSnapshot(filename);
  }

  onHome(): void {
    this.rawRoot = null;
    this.repoName = '';
    this.extColors = [];
    this.layout.result.set(null);
    this.layout.error.set(null);
    this.router.navigate(['']);
  }

  onParamsChange(params: LayoutParams): void {
    this.params = params;
    if (this.rawRoot) {
      this.resetCamera = false;
      this.scheduleLayout();
    }
  }

  private scheduleLayout(): void {
    if (!this.rawRoot) return;
    this.status.set('computing');
    this.layout.schedule(this.rawRoot, this.params, this.repoName);
  }
}
