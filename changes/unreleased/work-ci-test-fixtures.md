Test NATS servers reuse generated certificates while keeping separate files and
event histories. Stream creation retries once after a timeout and closes failed
fixtures before reporting the error.
