# Saved call status screens

Date: 2026-10-20. Source: 32e6690c106f262fe48439a3f21ac60d90bc1f1a plus working changes.

Environment: local Chromium with intercepted API replies; not a fresh installation. Command: `npm run visual:screen-p3-14-calls`. Expected and observed: saved status reads preserve the reason, wrap references and keep focus.

PASS: Reduced-motion browser fixtures at 1280px and 390px. The reason stays visible; long references wrap and cards fit the screen. Check status uses the original turn GET, keeps keyboard focus and has a 44px target with a 2px focus ring. A failed check keeps the last status; participants see no amounts.

NOT RUN: Fresh-install live journey. No stack or model call was used.

Captures: WRK-43-1280.png, participant-1280.png, changed-status-1280.png, unavailable-1280.png, WRK-43-390.png, participant-390.png, changed-status-390.png, unavailable-390.png.
