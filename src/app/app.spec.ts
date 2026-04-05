import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { App } from './app';

// Stub replaces the real Viewer so this test has no external dependencies
@Component({ selector: 'app-viewer', template: '', standalone: true })
class ViewerStub {}

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App] })
      .overrideComponent(App, { set: { imports: [ViewerStub] } })
      .compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render app-viewer', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-viewer')).toBeTruthy();
  });
});
