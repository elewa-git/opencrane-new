Budget writes recover their own saved events without losing holds or granting another send. Unrelated write conflicts, expired access and command-id collisions no longer permanently stop an unchanged writer. Uncertain writes block money decisions until recovery; the original two-second limit stays.

Saved retries check intervening budget writes before accepting the receipt, so a replacement writer's reserved money cannot be overlooked. Identical spending-limit requests made together return the same original receipt.
