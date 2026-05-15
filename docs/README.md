# SAIAR Manual (client package)

Standalone and embed instructions for the shipped client build.

## Folder layout

The manual is built with Vite. Sources at the project root:

- `index.html` (Vite entry / host page)
- `src/saiar-manual.js` (web component implementation; ES module entry)
- `src/steps.js` (manual content; `export default [...]`)
- `src/image-meta.js` (generated image dimensions; `export default {...}`)
- `public/images/` (optimized images, served verbatim by Vite — do not ship camera originals here)
- `public/assets/` (cover logo and similar static files)
- `vite.config.js`, `package.json` (build tooling)
- `scripts/optimize-images.mjs` (image optimization, run via `npm run optimize-images`)
- `docs/` (this file and embed example)

## Develop and build

From the project root:

```text
npm install
npm run dev      # local dev server on http://localhost:5173
npm run build    # produces dist/ for hosting (hashed JS bundle for cache busting)
npm run preview  # serves the built dist/ locally for verification
```

## Deploy

Run `npm run build` and upload the contents of `dist/` to any static host (object storage plus CDN, GitHub Pages, Netlify, IIS, nginx, and so on). The build emits a content-hashed JS bundle so deploys invalidate the browser cache automatically. No server runtime is required.

## Embed on your own site

After `npm run build`, copy the contents of `dist/` (or serve them from a shared static path) and load the hashed module bundle that Vite emits:

```html
<script type="module" src="/path/to/dist/assets/saiar-manual-<hash>.js"></script>
<saiar-manual
  data-image-base="/path/to/dist/images/"
  data-cover-logo="/path/to/dist/assets/logo.png"
  data-cover-title="SAIAR Lab Manual"
  data-show-toc="true"
  data-persist="both"
  data-theme="dark"
  data-lang="nl"></saiar-manual>
```

Adjust `/path/to/...` to match your deployment. See `docs/embed-example.html` for a full fake-site layout.

## Theming with CSS variables

Set custom properties on `<saiar-manual>` (or a wrapper) to tune colors, radius, shadow, and font. Supported hooks:

- `--saiar-bg`
- `--saiar-panel`
- `--saiar-panel-2`
- `--saiar-text`
- `--saiar-muted`
- `--saiar-line`
- `--saiar-accent`
- `--saiar-accent-text`
- `--saiar-shadow`
- `--saiar-warning-bg`
- `--saiar-warning-text`
- `--saiar-warning-line`
- `--saiar-radius`
- `--saiar-font`

Unknown variables are ignored and the built-in theme applies.

## Edit content (`src/steps.js`)

Steps are the default export of `src/steps.js` — an array of objects. Common fields:

- `id` - Stable slug for deep links and persistence.
- `section` - Section label for grouping.
- `title` - Step title.
- `intro` - Short lead text.
- `body` - Main HTML body (trusted content only).
- `warning` - Optional callout text.
- `image` - File name under the image base path.
- `imageAlt` - Alt text for the image.

**Security:** `body` (and similar fields if used) is injected as HTML. Treat `steps.js` as trusted, author-only content. Do not populate it from untrusted users or remote sources without sanitization.

## Image workflow

Only optimized media should ship under `public/images/`. Camera originals stay out of the bundle.

1. Store new originals anywhere on disk (not under `public/images/` in the shipped client).
2. From the project root, run:

```text
npm install
npm run optimize-images -- --input <path-to-originals-folder>
```

By default the script writes optimized variants into `public/images` and refreshes both `public/images/index.json` and `src/image-meta.js`. Use `--output <dir>` for a staging folder.

## Public API and events

- **Custom element:** `<saiar-manual>`
- **Attributes:** `data-src`, `data-image-base`, `data-cover-logo`, `data-cover-title`, `data-show-toc`, `data-persist`, `data-theme`, `data-start-step`, `data-lang` (see attribute names on `index.html`).
- **Methods:** `goToStep(n)`, `next()`, `prev()`, `complete()`.
- **Events:** `saiar:stepchange` and `saiar:complete` bubble from the element.
- **Upgrade hook:** after modules load, `customElements.whenDefined('saiar-manual')` resolves when the tag is safe to query or decorate.

CustomEvents (step changes, persistence sync, and similar) are dispatched on the element; event names and `detail` payloads are documented alongside `src/saiar-manual.js`. Prefer listening on the `<saiar-manual>` instance inside your app rather than patching internals.

## Troubleshooting

- **Empty manual:** Make sure the page is being served over HTTP (e.g. via `npm run dev`, `npm run preview`, or a real host). The bundle uses ES modules, which browsers block on `file://`.
- **Broken images:** Check `data-image-base` trailing slash and that files exist under `public/images/` in source (or `dist/images/` after build).
- **Script errors in old browsers:** Use a current evergreen browser. Vite targets `es2020`.
