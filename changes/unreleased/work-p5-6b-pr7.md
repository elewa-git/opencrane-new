Saved hosted image attempts now queue a private check. The worker uses trusted
image files, current scanner settings and separate signature, licence and
vulnerability checks before recording a result. Missing inputs leave the image
unadmitted, and hosted execution remains disabled.
Valid signature, licence and vulnerability failures now save a refusal, so a failed
attempt can be retried after the cause is fixed.
