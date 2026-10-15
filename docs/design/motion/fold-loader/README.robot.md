# Shared fold loader

For people, read [README.md](README.md) first.

These notes describe design ideas. The real app is in `apps/web`, and some file names here are not in git.

3 October 2026. Source: `work/fold-loader`, based on
`17c61d35ea840ea4f8e121c66c93c4aa09fce3b0`; after frames correspond to the
commit containing this receipt. Local Chromium against an isolated Angular
server, with HTTP/WebSocket fixtures. No shared dev stack was accessed.
This is browser qualification, not a fresh silo installation.

## Motion

The shared `oc-fold-loader` uses four equilateral triangles. Three outer panels
hinge around the centre's edges, with 120ms staggering in a 1.6s paper-ease loop.
Teal front faces give way to orange backs as panels pass through 90 degrees,
stack into one triangle, then unfold. CSS transforms handle depth; no runtime
inline styles or animation dependencies. Reduced motion shows a static fold.
The decorative component is hidden from assistive technology; existing text
announces the status. Sign-in uses a static shared-state spinner with reduced motion.
It still waits 2.5 seconds with Cancel focused throughout.

- [Animated loop, 20 frames per second](fold-loop.webp)
- [Sixteen motion phases, left to right then next row](fold-phases.png)
- Folding: [before desktop](before-folding-1280.png), [after desktop](after-folding-1280.png), [before phone](before-folding-390.png), [after phone](after-folding-390.png)
- Writing: [before desktop](before-streaming-1280.png), [after desktop](after-streaming-1280.png), [before phone](before-streaming-390.png), [after phone](after-streaming-390.png)
- Reduced motion: [folding](reduced-folding-390.png), [writing](reduced-streaming-390.png)

## Evidence

| Check | Result |
| --- | --- |
| Timing TDD | PASS: old countdown failed the new expectation; 2499ms has no navigation, 2500ms redirects; Cancel at 2400ms and destruction prevent redirect |
| Geometry TDD | PASS: browser assertion caught inherited alignment offset; explicit hinge position makes panels stack within 50px |
| `node scripts/check-fold-loader.mjs` | PASS: current folding and writing views at both widths, hidden decoration, active animations, folded geometry, no inline styles, no horizontal overflow, static reduced motion, 2.5-second redirect and Enter/Space Cancel |
| `npm run build -w apps/web` | PASS with bundle/CSS budget warnings |
| `npm run test -w apps/web -- --watch=false` | PASS: 45 tests |
| Browser web tests (`npx vitest run apps/web/test --maxWorkers=1`) | PASS across initial run and targeted retest: fold loader, production CSP, theme and state passed initially; legacy chat selector corrected, then `-t "qualifies the chat frames"` passed (other two browser tests skipped only in that retest) |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run check:events` | PASS: 75 event types |
| Full `npm test` | PARTIAL/FAIL: backend tests timed out (including bridge replay, chat, projections and authz); run stopped. No full-suite pass claimed |
| Real Zitadel / fresh install | NOT RUN; shared stack excluded by owner |

Before PNGs were recorded from the base implementation. After and reduced-motion
PNGs use the same local fixtures. `npm run visual:fold-loader` now captures the
folding and writing placements. The older handoff and `frame-*.png` files record
the former sign-in view and are not regenerated.

The final animated WebP was encoded with `img2webp` / libwebp 1.3.2
(BSD-3-Clause, checked in the package copyright file). Pillow 12.3.0
(MIT-CMU) assembled the PNG contact sheet. These tools were downloaded only to
`/tmp`; no application or runtime dependency was added. With `img2webp` available,
encode the captured frames with:

```sh
cd docs/design/motion/fold-loader
img2webp -loop 0 -lossless -d 50 frame-*.png -o fold-loop.webp
```
