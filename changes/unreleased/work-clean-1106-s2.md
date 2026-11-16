Chat calls keep the same tool, memory and payer restrictions while the gateway and
turn passes use the shared session configuration. The gateway derives its settings
from saved events and checked signed claims. Mismatched sharing claims are refused.

Gateway tests now prove both shared-child tool refusals using valid MCP metadata
and a real memory tool, with successful private-turn controls. They check that
initial and renewed shared passes grant no permit, memory pass or spending.
