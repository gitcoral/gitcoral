import { Component } from '@angular/core';
import { Viewer } from './features/viewer/viewer/viewer';

@Component({
  selector: 'app-root',
  imports: [Viewer],
  template: '<app-viewer />',
  styles: [':host { display: block; width: 100%; height: 100%; }'],
})
export class App {}
