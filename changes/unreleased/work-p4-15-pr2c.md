- Bind recall proofs to the saved input generation. Accept agent personal-memory writes only
  with every loaded reference from that same scope, refusing changed facts and ended contexts.
  Refuse grants changed during the final reference read, even if they are restored before it ends.
  Refuse a removed write grant or disabled assistant even immediately before the store saves
  the fact. Keep the original access deadline and conditional append.
  Native memory remains disabled.
