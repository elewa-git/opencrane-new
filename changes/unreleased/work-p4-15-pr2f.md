- Check agent correction and forget requests against personal read/write permissions, each tool's Allow rule and signed loaded targets. Both tools remain disabled and unadvertised; refused requests create no fact, key or command file.
- Agent memory tool configuration refusals use the same fixed response through the gateway and backend.
- Memory controls finish setup reads before signing; gateway tests check shutdown separately from replacement startup.
- Add controlled backend timing tests for memory recall, correction and forget. They reproduce valid
  requests refused after slow history or permission reads; the product fix remains outstanding.
