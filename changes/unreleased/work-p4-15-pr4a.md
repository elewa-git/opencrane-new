Added the proxy checks needed to keep private callers and their tool lists separate by turn. Connecting private process launches remains pending; memory stays disabled.

Fixed ordinary tool calls borrowing a private turn's pass, including after approval. The proxy checks the pass used for every call and refuses ordinary and private turns sharing a bound thread.
