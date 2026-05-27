# W3KITS

## Upstream

- upstream: `https://github.com/nexu-io/open-design`
- W3Kits fork: `https://github.com/W3Kits/open-design`
- marketplace slug: `opendesign`
- published package: `@w3kits/plugin-opendesign`
- runtime: `webcontainer`

## What W3Kits Changes

- packages the app as a reviewed W3Kits plugin instead of a standalone product build
- builds a browser entry and browser daemon for the shared W3Kits WebContainer runtime
- wires AI calls to `W3KITS_OPENAI_BASE_URL`
- verifies the emitted W3Kits package with `scripts/verify-w3kits-webcontainer-package.mjs`
- publishes `dist/` as the reviewed plugin artifact surface
- pins WebContainer daemon startup to the WebContainer root so shared runtimes resolve `__w3kits/...` correctly

## What Stays Upstream-Owned

- core product UX and feature direction
- prompt, skill, and design-system content unless W3Kits packaging requires otherwise
- general app architecture outside the plugin packaging layer

## Build

```bash
pnpm build
pnpm verify:w3kits-package
```

## Keep / Drop

Keep `open-design` as the maintained W3Kits source.

Do not keep a second long-lived `opendesign-source` working repo in this workspace. If diffing against upstream is needed, use the `upstream` remote on this repo.
