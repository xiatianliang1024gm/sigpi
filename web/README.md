# SigPi Website (web/)

Official SigPi website — an [Astro](https://astro.build) static site deployed on
Vercel.

## Local development

From the repo root:

```bash
pnpm install            # installs root + web deps
pnpm --filter web dev   # start dev server at http://localhost:4321
pnpm --filter web build # production build → web/dist
```

> **Registry note.** The repo's `.npmrc` points at an internal Nexus registry
> that does not mirror Astro or its dependencies (it also 404s some pre-existing
> deps on a fresh install). Until Astro is mirrored there, run installs with:
> `pnpm install --registry=https://registry.npmjs.org`.
> Vercel is unaffected — `.npmrc` is gitignored and never shipped.

## Deploying to Vercel

1. Create a project in your Vercel team, importing the `sigpi` GitHub repo.
2. Project Settings:
   - **Root Directory**: `web`
   - **Framework Preset**: Astro (auto-detected)
   - **Node.js Version**: 22.x
3. `web/vercel.json` pins `buildCommand: pnpm build` and
   `outputDirectory: dist` (both relative to the Root Directory).
4. Push to `main` → production deploy; PRs → preview deploys.
5. Add a custom domain under Project → Settings → Domains.

## Structure

```
web/
├── astro.config.mjs     # site URL, static output
├── vercel.json          # Vercel build settings
├── public/              # static assets (favicon)
└── src/
    ├── components/      # Header, Footer
    ├── pages/           # index.astro, docs.astro
    └── styles/          # global.css
```
