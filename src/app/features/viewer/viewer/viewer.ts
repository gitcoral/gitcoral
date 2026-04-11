import { Component, OnInit, effect, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';

import { GithubService } from '../../../core/services/github';
import { LayoutService } from '../../../core/services/layout';
import { DEFAULT_DISPLAY_OPTIONS, DEFAULT_LAYOUT_PARAMS, DisplayOptions, LayoutParams, LoadingState, TreeStructure } from '../../../shared/models/tree-node.model';
import { ControlsPanel, RepoSubmitEvent } from '../controls-panel/controls-panel';
import { ThreeCanvas } from '../three-canvas/three-canvas';

@Component({
  selector: 'app-viewer',
  imports: [ControlsPanel, ThreeCanvas],
  templateUrl: './viewer.html',
  styleUrl: './viewer.scss',
})
export class Viewer implements OnInit {

  resetCamera = false;
  display: DisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS };
  status = signal<LoadingState>('idle');
  initialRepo = '';

  get result() { return this.layout.result; }
  get error()  { return this.layout.error; }

  private rawRoot: TreeStructure | null = null;
  private repoName = '';
  private params: LayoutParams = { ...DEFAULT_LAYOUT_PARAMS };

  constructor(
    private github: GithubService,
    private layout: LayoutService,
    private router: Router,
  ) {
    // When layout finishes (result or error changes), go back to idle
    effect(() => {
      this.layout.result();
      this.layout.error();
      if (untracked(this.status) !== 'idle') this.status.set('idle');
    });
  }

  ngOnInit(): void {
    const repo = new URLSearchParams(window.location.search).get('repo');
    if (repo) {
      this.initialRepo = repo;
      this.onRepoSubmit({ url: repo });
    }
  }

  async onRepoSubmit(event: RepoSubmitEvent): Promise<void> {
    this.layout.error.set(null);
    const parsed = this.github.parseRepoUrl(event.url);
    if (!parsed) { this.layout.error.set('Invalid GitHub URL'); return; }

    this.router.navigate([], {
      queryParams: { repo: `${parsed.owner}/${parsed.repo}` },
      replaceUrl: false,
    });

    this.status.set('fetching');
    try {
      this.rawRoot = await this.github.fetchTree(parsed.owner, parsed.repo);
      this.repoName = `${parsed.owner}/${parsed.repo}`;
      this.resetCamera = true;
      this.scheduleLayout();
    } catch (e) {
      this.layout.error.set(e instanceof Error ? e.message : String(e));
      this.status.set('idle');
    }
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
