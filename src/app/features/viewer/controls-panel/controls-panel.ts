import { Component, EventEmitter, Input, OnDestroy, OnInit, Output, SimpleChanges, OnChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
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
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatCheckboxModule,
    MatSliderModule,
    MatIconModule,
    MatTooltipModule,
  ],
  templateUrl: './controls-panel.html',
  styleUrl: './controls-panel.scss',
})
export class ControlsPanel implements OnInit, OnChanges, OnDestroy {

  @Input() status: LoadingState = 'idle';
  @Input() initialRepo = '';
  @Output() repoSubmit     = new EventEmitter<RepoSubmitEvent>();
  @Output() paramsChange   = new EventEmitter<LayoutParams>();
  @Output() displayChange  = new EventEmitter<DisplayOptions>();

  repoUrl = '';
  params: LayoutParams = { ...DEFAULT_LAYOUT_PARAMS };
  display: DisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS };
  collapsed = false;

  readonly displayOptions: Array<{ key: keyof DisplayOptions; label: string }> = [
    { key: 'showFolders',    label: 'Folders'    },
    { key: 'showFiles',      label: 'Files'      },
    { key: 'showConnectors', label: 'Connectors' },
  ];

  readonly sliders: Array<{
    key: keyof LayoutParams;
    label: string;
    min: number;
    max: number;
    step: number;
  }> = [
    { key: 'zScale',      label: 'Z scale',        min: 0.1,  max: 2.0,  step: 0.05 },
    { key: 'buoyancy',    label: 'Buoyancy',        min: 0.1,  max: 6.0,  step: 0.1  },
    { key: 'repulsion',   label: 'Repulsion',       min: 0.1,  max: 6.0,  step: 0.1  },
    { key: 'decay',       label: 'Decay',           min: 0.3,  max: 0.99, step: 0.01 },
    { key: 'dotD',        label: 'File dot size',   min: 0.005, max: 0.1, step: 0.005 },
  ];

  private params$ = new Subject<LayoutParams>();
  private destroy$ = new Subject<void>();

  ngOnInit(): void {
    this.params$
      .pipe(debounceTime(500), takeUntil(this.destroy$))
      .subscribe(p => this.paramsChange.emit(p));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialRepo'] && this.initialRepo && !this.repoUrl) {
      this.repoUrl = this.initialRepo;
    }
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

  onDisplayChange(): void {
    this.displayChange.emit({ ...this.display });
  }

  onSubmit(): void {
    const url = this.repoUrl.trim();
    if (url) this.repoSubmit.emit({ url });
  }

  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
  }
}
