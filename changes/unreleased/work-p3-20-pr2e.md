Outside connections now have short operation-bound passes and a private decision
handler. All three destination rules must agree, and a saved spending stop refuses
the connection before a single-use relay is registered. Normal startup and command
worker networking remain off. Startup wiring and authorised receipt reads follow separately.

Outside connection admission now checks access again after saving its send permission.
A revocation, ended turn or expired deadline during a save retry refuses the relay
and records the unused dispatch's error outcome.
