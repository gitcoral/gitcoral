import { ActivatedRouteSnapshot, Routes } from '@angular/router';
import { Viewer } from './features/viewer/viewer/viewer';

export const routes: Routes = [
  {
    path: ':owner/:repo',
    component: Viewer,
    title: (route: ActivatedRouteSnapshot) =>
      `${route.params['owner']}/${route.params['repo']} — GitCoral`,
  },
  { path: '', component: Viewer, title: 'GitCoral — 3D GitHub Repository Visualizer' },
];
