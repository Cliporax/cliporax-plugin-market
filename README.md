# Cliporax Plugin Market

Static plugin market assets for Cliporax.

The repository builds a GitHub Release containing:

- `index.json`
- one `.cliporax-plugin.zip` package per plugin

## First Release Scope

The initial official market release includes:

- `com.cliporax.imagepreview`
- `com.cliporax.qrcode`
- `com.cliporax.qrscanner`

`com.cliporax.cloud-sync` is intentionally not published as a market plugin.
Cloud Sync keeps its sync engine, credential handling, encryption, and network
operations in the Cliporax Rust backend. If Cloud Sync is ever published here,
it should only be a UI shell that calls controlled `sync_*` backend commands.

`com.cliporax.qrscanner` is published as a normal market plugin. Cliporax still
owns the backend screen capture command it calls, but the plugin package itself
is not marked as builtin and can be installed or removed through the market UI.

## Layout

```text
plugins/<plugin_id>/manifest.json
plugins/<plugin_id>/src/main.ts
plugins/<plugin_id>/assets/icon.svg
plugins/<plugin_id>/README.md
plugins/<plugin_id>/CHANGELOG.md
third-party/<source>.json
market/index.json
schemas/market-index.schema.json
```

## Commands

```bash
npm ci
npm run build
npm run validate
npm run pack
npm run install:local
npm run install:local-dev
```

`npm run build` compiles plugin TypeScript sources, validates plugin manifests,
writes packages to `dist/`, and generates `market/index.json`.

`npm run install:local` installs built plugins into the production Cliporax
data directory. `npm run install:local-dev` installs them into the isolated
`com.cliporax.app.dev` data directory used by `npm run tauri:dev`.

Release URLs are generated from GitHub Actions environment variables by default.
For local builds, set `CLIPORAX_MARKET_RELEASE_BASE_URL`:

```bash
CLIPORAX_MARKET_RELEASE_BASE_URL=https://github.com/Cliporax/cliporax-plugin-market/releases/download/v0.1.0 npm run build
```

## Plugin Requirements

Each plugin directory must include:

- `manifest.json`
- `src/main.ts`
- an icon referenced by `manifest.icon`

`manifest.main` should continue to point at the compiled entry file, usually
`main.js`. The build emits JavaScript from `src/**/*.ts` before packaging.

The package may include additional resource files, but TypeScript source,
hidden files,
`node_modules`, build output directories, absolute paths, parent-directory
segments, and symlinks are rejected.

Icons may be SVG, PNG, WebP, JPG, or JPEG and must be 64 KB or smaller. The
build writes icon metadata and a small data URL into `market/index.json` so
Cliporax can render marketplace icons before downloading plugin packages.

## Third-Party Plugins

Third-party plugin authors may add complete market entries under
`third-party/*.json`. These entries are merged into `market/index.json` during
build and are always marked as non-official:

```json
"publisher": {
  "name": "Example Publisher",
  "url": "https://example.com",
  "official": false
}
```

The build rejects third-party entries that try to set `publisher.official` to
`true`. Official plugins packaged from `plugins/` are marked automatically with
`publisher.official: true`.
