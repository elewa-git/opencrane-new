# F1 foundation visual receipt

Checked on 4 October 2026 with `npm run visual:f1-foundation`. Chromium loaded the
built Angular assets and intercepted read fixtures; no stack or daemon was used.
The check captured `/org/states` and the integrations register in loading, loaded
and stale states at 1280px and 390px, with normal and reduced motion. All 16
captures are in this directory; `visual.json` records the checks.

## Comparison with the handoff

- The 390px loading register follows INT-02's 56px bar, full-width actions,
  labelled tabs and stacked rows. The skeleton and single checking message match
  the intended Grain and state treatment. It has no horizontal overflow.
- The loaded and stale register captures use the same paper, typography, spacing,
  state glyphs and dog-ear tokens as INT-03 and INT-07. They remain in the
  existing organisation shell with the existing register fields and actions;
  the redesigned navigation, search, status copy and detailed row composition
  visible in those frames belong to later organisation-screen work.
- The specimen demonstrates all eleven catalogue states plus the Folding,
  Flutter and Grain loaders. It checks the static reduced-motion treatment,
  matching the shared rules shown by INT-11, INT-19 and INT-19-RM. Those frames
  depict the admission workflow, which is not implemented by this foundation
  issue, so they are references for the shared states/loaders rather than
  screen-level matches.
- The 1280px captures retain the current app frame and organisation navigation.
  The paper texture is limited to the main surface; cards stay plain and use the
  shared 12px dog-ear. At both sizes the tab keyboard and focus checks pass.

The source-level visual check passes. This receipt does not claim that the
unimplemented admission screens or the later organisation shell match their
complete handoff frames.
