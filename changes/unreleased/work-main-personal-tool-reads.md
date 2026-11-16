Personal tool calls keep their assistant consent checks while reusing server history
and retaining only the assistant creation event needed for legacy consent. This
repairs the whole-stream read gate after two changes merged in a racing order.
