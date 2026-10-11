- Owners and admins can save or revoke one exact HTTPS destination rule and recover
  its original receipt after a lost reply. Rule tables can be rebuilt from events.
  Networking stays disabled; decision bindings and richer history are later work.
- A saved destination change reference keeps its original host, port, scope and
  subject. Changed references return a conflict even when requests race. Reserved
  internal names, including `home.arpa` and names beneath it, are refused.
