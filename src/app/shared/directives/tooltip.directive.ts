import {
  Directive,
  ElementRef,
  HostListener,
  Input,
  OnDestroy,
  Renderer2,
  inject,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';

@Directive({
  selector: '[appTooltip]',
})
export class TooltipDirective implements OnDestroy {
  @Input('appTooltip') text = '';

  private el = inject(ElementRef);
  private renderer = inject(Renderer2);
  private document = inject(DOCUMENT);

  private tipEl: HTMLElement | null = null;
  private rafId = 0;

  @HostListener('mouseenter')
  onMouseEnter(): void {
    if (!this.text) return;
    this.tipEl = this.renderer.createElement('div');
    this.renderer.addClass(this.tipEl, 'orb-tip');
    this.renderer.setProperty(this.tipEl, 'textContent', this.text);
    this.renderer.setStyle(this.tipEl, 'visibility', 'hidden');
    this.renderer.appendChild(this.document.body, this.tipEl);

    this.rafId = requestAnimationFrame(() => {
      if (!this.tipEl) return;
      const r = this.el.nativeElement.getBoundingClientRect();
      const tipWidth = this.tipEl.offsetWidth;
      const viewport = this.document.documentElement.clientWidth;
      const centered = r.left + r.width / 2 - tipWidth / 2;
      const left = Math.max(8, Math.min(centered, viewport - tipWidth - 8));
      this.renderer.setStyle(this.tipEl, 'left', `${left}px`);
      this.renderer.setStyle(this.tipEl, 'top', `${r.bottom + 6}px`);
      this.renderer.setStyle(this.tipEl, 'visibility', 'visible');
    });
  }

  @HostListener('mouseleave')
  onMouseLeave(): void {
    cancelAnimationFrame(this.rafId);
    this.tipEl?.remove();
    this.tipEl = null;
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    this.tipEl?.remove();
  }
}
