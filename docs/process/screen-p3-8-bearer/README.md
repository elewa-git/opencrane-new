# Personal tool connections display receipt

The eight PNGs here come from the built website with intercepted API replies.
They show an empty saved list, a saved profile list, safe profile details and a
revoke review at 1280 and 390 pixels. The browser check found no horizontal
overflow, checked 44-pixel controls and returned focus after review Cancel.

Compared with the matching INT-60, INT-61, INT-65 and INT-66 handoff frames:

- **PARTIAL:** The paper settings shell, stacked phone rows and full-width phone
  review follow the frames. The review states the local effect, no account
  fallback and the provider-token limit. It names the safe integration and
  profile ids in both review captures.
- **NOT RUN:** The empty frame's eligible, unconnected server cannot be shown.
  The landed member API lists saved profiles for one supplied server only.
- **NOT RUN:** The list frame's provider account name, scopes and checked time,
  and the replacement frame's verified identity, need backend fields that the
  landed list and detail replies do not provide. The safe detail capture says
  “identity unverified” and does not claim a replacement happened.
- **NOT RUN:** Live installation and provider token behaviour. No dev stack or
  paid service was used for these captures.

The component tests cover loading, empty and paged lists, failed refresh,
search, refused access, reversed detail replies and one unknown revoke reference
restored after navigation.
