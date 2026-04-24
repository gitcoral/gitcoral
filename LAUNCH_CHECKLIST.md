# Launch Promotion Checklist

## P0 — Blockers (fix before any sharing)

- [x] **Meta tags** — add to `src/index.html`:
  - `<meta name="description">` with a value proposition
  - `og:title`, `og:description`, `og:url`, `og:type`, `og:image`
  - `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`
  - `<link rel="canonical">`

- [x] **robots.txt** — create `public/robots.txt`

## P1 — High impact

- [ ] **og:image / social card** — use the snapshot feature to capture a good-looking visualization and use it as the static social preview image

- [ ] **Landing / empty state** — when the user lands on `/` with no repo, show a short hero ("3D visualization of any GitHub repo") and a few clickable example repos (e.g. `facebook/react`, `torvalds/linux`, `angular/angular`) to reduce friction and demonstrate the app immediately

- [ ] **Analytics** — add Plausible or Google Analytics to measure traffic and conversion

- [x] **"Star on GitHub" button** — decided against it; footer GitHub link is sufficient

## P2 — Before any big push

- [ ] **Mobile responsiveness** — the sidebar is 260px fixed width with no media queries; test on phones and add breakpoints so it doesn't overflow on small screens

- [ ] **Example repos in empty state** — even without a full landing page, clickable examples on the empty input state let visitors see the app in action in one click

## P3 — Polish

- [x] **Remove Angular boilerplate** from `src/app/app.html` (placeholder "Hello Angular" template content)

- [x] **Bump version** — `package.json` is at `0.0.0`

