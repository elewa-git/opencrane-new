Tests can build saved events, signed-in headers, permission stores and members
through shared testing entry points. The ops departure tests reuse the event
builder with explicit named fields.
The builder accepts only its required fields and an optional event id, and a
refused-append test checks that it fails the calling test. Nightly-memory tests
keep their specific envelope construction locally, preserving identities,
timestamps and assertions.
