Signed-out live-view admission and WebSocket requests now receive a refusal without adding permanent events, including when viewer capacity is full. Valid signed-in refusals still save exactly one audit event, including requests with missing or hostile Origins.

Fresh secondary development stacks now wait for PostgreSQL TCP readiness before database setup.
