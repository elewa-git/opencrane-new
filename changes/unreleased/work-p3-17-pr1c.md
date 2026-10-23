Enabled control requests now record safe requester-only and conflicting attempts without
changing the current controller or running work. Retries recover the saved refusal;
uncertain audit storage returns unavailable. Production control remains disabled.

Refusals recheck access before saving and keep the original permission deadline.
Competing accepted and refused requests save one outcome per command. The requester
can read their refusal in conversation history, including after a rebuild.
