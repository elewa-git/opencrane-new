# Saved spending in a private maintenance detail

## Result

An authorised reader can open one saved maintenance detail and see its accepted
100-cent allowance separately from a matching call's held and spent cents. The
detail reads the existing budget root and call tables. It uses the original
root, scope, night, member, payer and assistant to check the match. A late
settlement changes the current money view without changing the saved receipt.

Missing, lagged, contradictory or slow money records leave money unavailable.
An expired reservation or uncertain outcome keeps its hold until saved
settlement or release evidence changes it. Readers who lose access and admins
outside the scope receive the same private refusal as before.

## Checks

The focused test was committed while failing on the missing spending join.
Check results are recorded in the pull request body. A fresh-install journey
was not run. No development stack or model, scheduler or tool call was started.
