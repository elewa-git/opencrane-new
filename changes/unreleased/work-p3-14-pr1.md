- Save budget stop reasons with their spending scope, limit and UTC reset time.
  Stop model reservations when a ceiling is zero or lowered to money spent or held.
  A changed limit or new period can admit new work; stopped work stays stopped after replay.
  Save turns refused by an existing stop before replying, so a later ceiling rise
  or UTC reset cannot reopen them. Repeated refusals reuse the saved stop reference.
  Name the cap that stopped the turn in the refusal, using its saved reasons.
  Applying stops to all tool calls and running computers follows separately.
