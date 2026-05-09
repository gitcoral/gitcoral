import { Injectable, OnDestroy, signal } from '@angular/core';
import { Subject, debounceTime, takeUntil } from 'rxjs';
import {
  DEFAULT_LAYOUT_PARAMS,
  LayoutParams,
  LayoutResult,
  TreeStructure,
  WorkerRequest,
  WorkerResponse,
} from '../../shared/models/tree-node.model';

interface PendingRequest {
  root: TreeStructure;
  params: LayoutParams;
  repoName: string;
  headRepoName: string;
  ref: string;
  vsRef: string;
  isDiff: boolean;
  prNumber: number | null;
}

@Injectable({ providedIn: 'root' })
export class LayoutService implements OnDestroy {
  private readonly DEBOUNCE_MS = 500;

  private worker: Worker | null = null;
  private request$ = new Subject<PendingRequest>();
  private destroy$ = new Subject<void>();

  /** Signal — components read this reactively, change detection fires automatically */
  readonly result = signal<LayoutResult | null>(null);
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);

  constructor() {
    if (typeof Worker !== 'undefined') {
      this.worker = new Worker(new URL('../workers/layout.worker', import.meta.url), {
        type: 'module',
      });
    }

    this.request$
      .pipe(debounceTime(this.DEBOUNCE_MS), takeUntil(this.destroy$))
      .subscribe((req) => this.runWorker(req));
  }

  schedule(
    root: TreeStructure,
    params: LayoutParams = DEFAULT_LAYOUT_PARAMS,
    repoName = '',
    headRepoName = '',
    ref = '',
    vsRef = '',
    isDiff = false,
    prNumber: number | null = null,
  ): void {
    this.loading.set(true);
    this.request$.next({ root, params, repoName, headRepoName, ref, vsRef, isDiff, prNumber });
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.destroy$.next();
    this.destroy$.complete();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private runWorker(req: PendingRequest): void {
    if (!this.worker) {
      this.error.set('Web Workers are not supported in this environment');
      this.loading.set(false);
      return;
    }

    const onMessage = ({ data }: MessageEvent<WorkerResponse>) => {
      this.worker!.removeEventListener('message', onMessage);
      this.worker!.removeEventListener('error', onError);
      if (data.error) {
        this.error.set(data.error);
      } else {
        this.result.set({ ...data.result, prNumber: req.prNumber });
      }
      this.loading.set(false);
    };

    const onError = (err: ErrorEvent) => {
      this.worker!.removeEventListener('message', onMessage);
      this.worker!.removeEventListener('error', onError);
      this.error.set(err.message);
      this.loading.set(false);
    };

    this.worker.addEventListener('message', onMessage);
    this.worker.addEventListener('error', onError);
    this.worker.postMessage({
      root: req.root,
      params: req.params,
      repoName: req.repoName,
      headRepoName: req.headRepoName,
      ref: req.ref,
      vsRef: req.vsRef,
      isDiff: req.isDiff,
    } as WorkerRequest);
  }
}
