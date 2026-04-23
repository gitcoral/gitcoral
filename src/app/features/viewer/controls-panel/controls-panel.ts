import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, OnInit, Output, SimpleChanges, OnChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSliderModule } from '@angular/material/slider';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subject, debounceTime, takeUntil } from 'rxjs';
import { DEFAULT_DISPLAY_OPTIONS, DEFAULT_LAYOUT_PARAMS, DisplayOptions, LayoutParams, LoadingState } from '../../../shared/models/tree-node.model';

export interface RepoSubmitEvent {
  url: string;
}

@Component({
  selector: 'app-controls-panel',
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatSliderModule,
    MatIconModule,
    MatTooltipModule,
  ],
  templateUrl: './controls-panel.html',
  styleUrl: './controls-panel.scss',
})
export class ControlsPanel implements OnInit, OnChanges, AfterViewInit, OnDestroy {

  @Input() status: LoadingState = 'idle';
  @Input() initialRepo = '';
  @Input() maxFileSize = 0;
  @Input() maxDepth = 0;
  @Input() extColors: { ext: string; label: string; color: string; count: number }[] = [];
  @Output() repoSubmit      = new EventEmitter<RepoSubmitEvent>();
  @Output() paramsChange    = new EventEmitter<LayoutParams>();
  @Output() displayChange   = new EventEmitter<DisplayOptions>();
  @Output() snapshotRequest = new EventEmitter<void>();
  @Output() cameraResetRequest = new EventEmitter<void>();

  repoUrl = '';
  params: LayoutParams = { ...DEFAULT_LAYOUT_PARAMS };
  display: DisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS };
  collapsed = false;
  displayExpanded = false;
  layoutExpanded = false;
  extExpanded = false;

  readonly EXT_LIMIT = 12;

  // Log-scale slider positions (0–1000); converted to bytes on change.
  fileSizePosMin = 0;
  fileSizePosMax = 1000;

  readonly displayOptions: Array<{ key: keyof DisplayOptions; label: string }> = [
    { key: 'showFiles',      label: 'Files'      },
    { key: 'showFolders',    label: 'Folders'    },
    { key: 'showConnectors', label: 'Connectors' },
  ];

  readonly sliders: Array<{
    key: keyof LayoutParams;
    label: string;
    min: number;
    max: number;
    step: number;
    tooltip: string;
  }> = [
    { key: 'zScale',    label: 'Z scale',          min: 0.1,   max: 2.0,  step: 0.05,  tooltip: 'Vertical stretch of the hierarchy — higher values push layers further apart'      },
    { key: 'buoyancy',  label: 'Buoyancy',          min: 0.1,   max: 6.0,  step: 0.1,   tooltip: 'Downward pull on folder nodes within their layer — increase to spread them out'   },
    { key: 'repulsion', label: 'Repulsion',          min: 0.1,   max: 6.0,  step: 0.1,   tooltip: 'How strongly folders push each other apart — increase if nodes overlap'           },
    { key: 'spread',    label: 'Spread',             min: 0.3,   max: 0.99, step: 0.01,  tooltip: 'How tightly child folders cluster within their parent sphere'                     },
    { key: 'sphereD',   label: 'File sphere size',   min: 0.005, max: 0.1,  step: 0.005, tooltip: 'Radius of the point cloud of files orbiting each folder'                         },
  ];

  private params$ = new Subject<LayoutParams>();
  private query$  = new Subject<void>();
  private destroy$ = new Subject<void>();

  constructor(private el: ElementRef<HTMLElement>) {
    this.el.nativeElement.classList.add('no-transitions');
  }

  ngAfterViewInit(): void {
    requestAnimationFrame(() => this.el.nativeElement.classList.remove('no-transitions'));
  }

  ngOnInit(): void {
    this.params$
      .pipe(debounceTime(500), takeUntil(this.destroy$))
      .subscribe(p => this.paramsChange.emit(p));
    this.query$
      .pipe(debounceTime(300), takeUntil(this.destroy$))
      .subscribe(() => this.displayChange.emit({ ...this.display }));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialRepo'] && this.initialRepo && !this.repoUrl) {
      this.repoUrl = this.initialRepo;
    }
    if (changes['maxFileSize'] && this.maxFileSize > 0) {
      this.fileSizePosMin = 0;
      this.fileSizePosMax = 1000;
      this.display.fileSizeMin = 0;
      this.display.fileSizeMax = this.maxFileSize;
      this.displayChange.emit({ ...this.display });
    }
    if (changes['maxDepth'] && this.maxDepth > 0) {
      this.display.depthMin = 0;
      this.display.depthMax = this.maxDepth;
      this.displayChange.emit({ ...this.display });
    }
    if (changes['extColors'] && !changes['extColors'].firstChange) {
      // New repo loaded — reset hidden extensions, path query, and collapsed state
      this.display.hiddenExtensions = [];
      this.display.pathQuery = '';
      this.extExpanded = false;
      this.displayChange.emit({ ...this.display });
    }
  }

  get visibleExtColors() {
    return this.extExpanded ? this.extColors : this.extColors.slice(0, this.EXT_LIMIT);
  }

  toggleExtExpanded(): void {
    this.extExpanded = !this.extExpanded;
  }

  isExtHidden(ext: string): boolean {
    return this.display.hiddenExtensions.includes(ext);
  }

  toggleExtension(ext: string): void {
    const hidden = this.display.hiddenExtensions;
    this.display.hiddenExtensions = hidden.includes(ext)
      ? hidden.filter(e => e !== ext)
      : [...hidden, ext];
    this.displayChange.emit({ ...this.display });
  }

  selectAllExtensions(): void {
    this.display.hiddenExtensions = [];
    this.displayChange.emit({ ...this.display });
  }

  selectNoneExtensions(): void {
    this.display.hiddenExtensions = this.extColors.map(e => e.ext);
    this.displayChange.emit({ ...this.display });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onSliderChange(): void {
    this.params$.next({ ...this.params });
  }

  onReset(): void {
    this.params = { ...DEFAULT_LAYOUT_PARAMS };
    this.params$.next({ ...this.params });
  }

  onDisplayReset(): void {
    this.display = {
      ...DEFAULT_DISPLAY_OPTIONS,
      fileSizeMin: this.display.fileSizeMin,
      fileSizeMax: this.display.fileSizeMax,
      depthMin: 0,
      depthMax: this.maxDepth || Number.MAX_SAFE_INTEGER,
      pathQuery: '',
      hiddenExtensions: [],
    };
    this.fileSizePosMin = 0;
    this.fileSizePosMax = 1000;
    this.displayChange.emit({ ...this.display });
  }

  onDisplayChange(): void {
    this.displayChange.emit({ ...this.display });
  }

  onQueryChange(): void {
    this.query$.next();
  }

  clearQuery(): void {
    this.display.pathQuery = '';
    this.displayChange.emit({ ...this.display });
  }

  linkCopied = false;

  onSnapshot(): void {
    this.snapshotRequest.emit();
  }

  onCameraReset(): void {
    this.cameraResetRequest.emit();
  }

  onCopyLink(): void {
    navigator.clipboard.writeText(window.location.href).then(() => {
      this.linkCopied = true;
      setTimeout(() => this.linkCopied = false, 2000);
    });
  }

  onSubmit(): void {
    const url = this.repoUrl.trim();
    if (url) this.repoSubmit.emit({ url });
  }

  onFileSizeChange(): void {
    this.display.fileSizeMin = this.posToBytes(this.fileSizePosMin);
    this.display.fileSizeMax = this.posToBytes(this.fileSizePosMax);
    this.displayChange.emit({ ...this.display });
  }

  formatCount(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  formatBytes(b: number): string {
    if (b >= 1_000_000) return (b / 1_000_000).toFixed(1).replace(/\.0$/, '') + ' MB';
    if (b >= 1_000)     return (b / 1_000).toFixed(1).replace(/\.0$/, '') + ' KB';
    return b + ' B';
  }

  private posToBytes(pos: number): number {
    if (pos <= 0) return 0;
    if (pos >= 1000) return this.maxFileSize;
    return Math.round(Math.exp(pos / 1000 * Math.log(this.maxFileSize + 1)) - 1);
  }

  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
  }
}
