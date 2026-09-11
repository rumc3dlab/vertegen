# Vertebra PCA Explorer

A browser-based companion app for **“A Morphable Model of the Human Spine”**.

## Local development

The app is built with Vite and TypeScript.

```bash
npm ci
npm run dev
```

For a production build:

```bash
npm run build
npm run preview
```

## Required `public/` content

The `public/` directory is copied unchanged into the production build. Keep the existing data/model files there, including the `data/` directory used by the PCA explorer.

The header expects these theme-aware logo files in `public/`:

- `logo-whitemode.svg` — used in light mode
- `logo-darkmode.svg` — used in dark mode

The existing footer also expects:

- `logo-RGB.svg`
- `logo-White.svg`

## GitHub Pages deployment

This repository includes `.github/workflows/deploy-pages.yml`. It installs dependencies, runs the Vite production build, uploads `dist/`, and deploys it with GitHub Pages.

1. Commit the complete project, including `public/`, to a GitHub repository.
2. Push the project to the `main` branch. If your default deployment branch has a different name, change `branches: [main]` in `.github/workflows/deploy-pages.yml`.
3. In GitHub, open **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to **GitHub Actions**.
5. Push a commit to `main`, or open the **Actions** tab and run **Deploy to GitHub Pages** manually.
6. When the workflow succeeds, the deployment URL is shown in the workflow and in **Settings → Pages**.

The Vite config uses `base: "./"`, and public/data URLs are relative/base-aware, so the same build works for a project site such as `https://USERNAME.github.io/REPOSITORY/` without hard-coding the repository name.

### GitHub Pages size considerations

This app serves PCA/model data as static files. GitHub Pages currently limits a published site to 1 GB, and normal Git repositories reject individual files larger than 100 MiB. If the `public/` dataset exceeds those limits, host the large model/data files elsewhere (or use another static host) and point the app at that asset location instead.
