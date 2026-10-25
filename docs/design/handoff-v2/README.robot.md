# Claude Design handoff v2

For people, read [README.md](README.md) first.

These notes describe design ideas. The real app is in `apps/web`, and some file names here are not in git.

The owner ran the ten prompts in [claude-design-briefs.md](../claude-design-briefs.md) in
Claude Design and returned these handoffs on 4 October 2026. They are **designed states, not
implementation evidence**: nothing here shows that the product behaves this way.

## Areas

| Folder | Area | States | Tickets |
| --- | --- | ---: | --- |
| [01-int](01-int/README.robot.md) | Integrations & My tools (INT) | 75 | P3-4 (#45), P3-6 (#47), P3-7 (#48), P3-8 (#49), P3-9 (#50), P3-10 (#51), P3-20 (#61), P4-23 (#105) |
| [02-wrk](02-wrk/README.robot.md) | Workspace effects (WRK) | 66 | P3-5 (#46), P3-12 (#53), P3-14 (#55), P3-17 (#58), P3-18 (#59), P3-20 (#61), P3-21 (#62) |
| [03-spd](03-spd/README.robot.md) | Spending (SPD) | 37 | P3-15 (#56), P4-26 (#108) |
| [04-ppl](04-ppl/README.robot.md) | People & groups (PPL) | 40 | P4-1 (#83), P4-2 (#84), P4-3 (#85), P4-7 (#89) |
| [05-thr](05-thr/README.robot.md) | Threads & delegation (THR) | 39 | P4-4 (#86), P4-5 (#87), P4-6 (#88), P4-8 (#90), P4-9 (#91), P4-10 (#92), P4-11 (#93), P4-14 (#96), P4-7 (#89) |
| [06-mem](06-mem/README.robot.md) | Memory (MEM) | 27 | P4-12 (#94), P4-13 (#95), P4-15 (#97), P4-16 (#98), P4-17 (#99), P4-14 (#96) |
| [07-onb](07-onb/README.robot.md) | Onboarding & account (ONB) | 26 | P4-18 (#100), P4-19 (#101), P4-20 (#102) |
| [08-mod](08-mod/README.robot.md) | Models & providers (MOD) | 26 | P4-21 (#103), P4-22 (#104) |
| [09-rtn](09-rtn/README.robot.md) | Routines (RTN) | 29 | P4-24 (#106), P4-25 (#107) |
| [10-ovr](10-ovr/README.robot.md) | Overview & history (OVR) | 15 | P4-27 (#109), P3-22 (#63), P4-28 (#110) |

## What is in the repository

- `NN-key/README.robot.md`: the handoff's full notes, kept intact. It lists every state id, the
  shared paper and origami system, the state vocabulary, keyboard, accessibility, 390px and
  reduced-motion rules.
- `NN-key/source.dc.html`: the design source for that handoff. Open it in a browser; it loads
  `shared/support.js` and the DM Sans and DM Mono fonts from `shared/`.

The rendered frames (`png/<ID>-1280.png` and `png/<ID>-390.png`, 760 images, about 82MB) and
the self-contained offline HTML are kept out of git. On the dev box they are in
`<home>/dev/design-handoffs/v2/<NN-key>/`, with the original zips in `zips/`.

## How builders use it

- Recreate the frames in `apps/web` (the handoff notes call it `apps/opencrane-ui`) with Angular
  components. Do not copy the design's inline HTML or `support.js`.
- Build the shared pieces once (the organisation and settings shells, the paper and origami
  system, the state glyphs and the loaders), then each ticket's screens on top of them. The
  [integration plan](PLAN.md) maps every state id to its ticket and sets the order.
- Every screen has a 1280px and a 390px layout and a reduced-motion variant, and follows the
  code style in [AGENTS.md](../../../AGENTS.md#style).
