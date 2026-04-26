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

- [x] **Landing / empty state** — example repo cards shown on `/`, Filter/Display/Layout hidden until a repo is loaded; logo navigates home

- [x] **Analytics** — Cloudflare Web Analytics enabled via Automatic setup (server-side, no JS snippet needed)

- [x] **"Star on GitHub" button** — decided against it; footer GitHub link is sufficient

## P2 — Before any big push

- [x] **Mobile responsiveness** — tested on iPhone 14 Pro, looks good as-is

- [x] **Example repos in empty state** — done as part of landing/empty state above

## P3 — Polish

- [x] **Remove Angular boilerplate** from `src/app/app.html` (placeholder "Hello Angular" template content)

- [x] **Bump version** — `package.json` is at `0.0.0`
