# Deployment Runbook — V1 (upload-only, free-first)

## Scope

V1 ships the upload-driven workflows: CSV research, chart-image analysis,
Strategy Comparison Lab, Historical Validation, Experiment Registry, replay
bundles, and the browser-local input archive — plus the public site pages.
Provider-backed surfaces (live markets, scanner, watchlist, alerts) serve
labelled demo/unavailable states — no live market data is distributed.

## Hosting target

**Recommended: Vercel Hobby (free tier).**
- First-party Next.js 16 support — no adapter, `next build`/`next start` as-is.
- HTTPS and a `*.vercel.app` domain included; custom domain + automatic TLS free.
- Route handlers run as serverless functions — POST multipart is supported.
- Constraint: Hobby request body limit ≈ 4.5 MB. Upload contract allows
  4 files × 5 MiB — large combined uploads may hit the platform limit with a
  `413` before reaching app validation. Acceptable for V1 (limits unchanged);
  if it bites, move the upload routes to a Node host (Render/Railway free tier)
  or compress client-side first. Document, don't relax the app-side limits.

Alternative: **Render free web service** — plain `next start`, no body cap at
the platform proxy, but cold-starts on the free tier.

## Environment variables (set in the host dashboard — never in the repo)

| Var | Required | Value |
| --- | --- | --- |
| `POLYGON_API_KEY` | optional | operator's key — absent = provider surfaces stay demo/unavailable, which is the V1 intent |
| `POLYGON_PLAN` | optional | `basic`/`starter`/`developer`/`advanced` — unset infers Basic/EOD, marked `inferred` |
| `MARKET_DATA_BASE_URL` | optional | Polygon endpoint override |
| `VISION_RUNTIME_URL`, `VISION_MODEL` | optional | local Ollama vision — omit on hosted deploys; the deterministic pipeline works without it |

**Never set `MARKET_DATA_SERVING=internal` on a public deployment.** That env
disables the display-rights gate (`src/lib/market-data/providers/serving.ts`) —
it exists only for development/internal-operation reads. Production already
defaults to `public`; leaving the var unset is the safe configuration. Setting
`internal` to make live data appear without a recorded vendor agreement is a
licensing violation, not a workaround.

## Build & start

```bash
npm ci
npm run build   # next build — verified green 2026-10-18
npm start       # next start — serves on PORT (default 3000)
```

On Vercel: import the repo, framework preset auto-detected, no overrides needed.

## Pre-deploy checklist

1. Commit the pending release files (list reported in the launch-gate review).
2. `npm run typecheck` → 0 errors; `npm run lint` → clean; `npm test` →
   1411 passed | 1 skipped (intentional `OCR_BENCHMARK` gate).
3. `npm run build` → 0 errors.

## Production smoke test (post-deploy, ~15 min)

1. Open the site → dashboard renders; provider surfaces show **demo/unavailable**
   labels, not fabricated prices.
2. `/validation` → upload a CSV → tick **Archive inputs locally** → run a
   2-strategy comparison → result registers.
3. Reload → Experiment Registry → record shows `inputs archived` badge →
   **export bundle (archived inputs)** → verification shows `verified`.
4. **Import replay bundle** with that bundle → run replay → fingerprint equals
   the original record's fingerprint.
5. DevTools → Console: no errors; Application → IndexedDB → `ti-input-archive`
   contains the entry (byte payloads).
6. DevTools → Lighthouse mobile viewport → layout unbroken at 375 px.

## Rollback

- Vercel: Deployments → previous deployment → **Promote to Production**
  (instant; immutable builds). Keep the previous deployment until smoke passes.
- Self-host: keep the prior `git` tag; `git checkout <tag> && npm ci && npm run
  build && npm start`. Database/state is browser-local only — no server-side
  state to migrate or roll back.

## Known residual risk

`npm audit` — 5 high findings, all one chain: `eslint-config-next` →
`@next/eslint-plugin-next` → `fast-glob` → `micromatch`/`braces` ≤3.0.3
(GHSA-vfj7-8cjw-p6xm, stack-exhaustion DoS). **No upstream fix exists** —
3.0.3 is the latest `braces` release. Dev-only: none of these packages ship to
production (`npm ls --omit=dev` clean). Impact on the released app: zero.
Re-check after upstream publishes a fix; do not `audit fix --force` (it
downgrades `eslint-config-next` to 14.x — rejected).
