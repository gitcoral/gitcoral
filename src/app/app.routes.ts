import { Routes } from '@angular/router';
import { Viewer } from './features/viewer/viewer/viewer';

export const routes: Routes = [
  { path: ':owner/:repo', component: Viewer },
  { path: '', component: Viewer },
];
