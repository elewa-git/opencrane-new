Repeat development stack starts check handler subscriptions before starting apps.
They apply safe changes while workers are stopped, report changes needing maintenance,
and wait for the dispatcher to consume events before saying the stack is ready.
