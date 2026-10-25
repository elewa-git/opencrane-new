# Masked screenshot emails

The screenshots below have opaque black boxes over email addresses at the
owner's domain. The boxes use recognised text positions with a small margin.
Each image keeps its original dimensions, colour mode and pixels outside the
boxes. The images were edited in place without rewriting Git history.

## Masked files

The first privacy sweep identified 12 images. A further scan found a placeholder
email at the same domain in the sign-in wireframe. The members wireframe also
has several addresses at that domain. All of those addresses are masked,
including the owner text in the dimmed member list behind invitation forms.

- [docs/design/chat/wireframes/01-1a-sign-in.png](../design/chat/wireframes/01-1a-sign-in.png)
- [docs/design/chat/wireframes/01-1c-magic-link-sent.png](../design/chat/wireframes/01-1c-magic-link-sent.png)
- [docs/design/chat/wireframes/01-1d-sign-in-rejected.png](../design/chat/wireframes/01-1d-sign-in-rejected.png)
- [docs/design/chat/wireframes/08-13a-account-settings.png](../design/chat/wireframes/08-13a-account-settings.png)
- [docs/design/chat/wireframes/08-13b-members-invite.png](../design/chat/wireframes/08-13b-members-invite.png)
- [docs/process/demo-rehearsal/failed-abacbe417/unopened-invite-1280.png](demo-rehearsal/failed-abacbe417/unopened-invite-1280.png)
- [docs/process/demo-rehearsal/prior-d89186d28-a/pages/unopened-invite-1280.png](demo-rehearsal/prior-d89186d28-a/pages/unopened-invite-1280.png)
- [docs/process/demo-rehearsal/rehearsal-a/pages/unopened-invite-1280.png](demo-rehearsal/rehearsal-a/pages/unopened-invite-1280.png)
- [docs/process/demo-rehearsal/rehearsal-b/pages/unopened-invite-1280.png](demo-rehearsal/rehearsal-b/pages/unopened-invite-1280.png)
- [docs/process/screen-p4-3-invite/PPL-40-1280.png](screen-p4-3-invite/PPL-40-1280.png)
- [docs/process/screen-p4-3-invite/PPL-41-1280.png](screen-p4-3-invite/PPL-41-1280.png)
- [docs/process/screen-p4-3-invite/PPL-42-1280.png](screen-p4-3-invite/PPL-42-1280.png)
- [docs/process/screen-p4-3-invite/PPL-43-1280.png](screen-p4-3-invite/PPL-43-1280.png)

Visual inspection of all 13 edited images: PASS. There are 18 boxes in total.
Pixel comparison against the original images: PASS. The boxes are fully opaque,
and every pixel outside them is unchanged. No application dependency was added.

No tracked text records a file hash for these images, so no receipt or hash list
needed a new value. The check covered MD5, SHA-1, SHA-256 and SHA-512 values.

## Other email text

[The email-image list](public-privacy-email-image-candidates.txt) records 49 image
file names found by text recognition and manual inspection, including the masked
files above. It also includes ordinary
example addresses, such as the one shown for Alex Kim in
[owner-target-1280.png](screen-p4-3-role/owner-target-1280.png), and a generic work
address in [the sign-in wireframe](../design/chat/wireframes/01-1a-sign-in.png),
which is now masked because it used the owner's domain.

## Coverage

Follow-up text recognition: PASS for all 3,384 tracked image file names under
`docs/`, covering 2,662 distinct file contents. Adaptive thresholding checked
dimmed text behind invitation forms. The animated WebP was checked through all
29 extracted frames because the recogniser could not open the animation itself.

An enlarged check with standard thresholding covered 802 candidate image paths
and 681 distinct contents, including every edited image. It found no remaining
owner-domain email matches: PASS.

Text recognition can miss text, so it does not prove that every other image is
free of private details. Visual inspection of every other image is NOT RUN.
