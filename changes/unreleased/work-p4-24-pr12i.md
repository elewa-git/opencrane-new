- Saved routine Stop now cancels its waiting start acknowledgement and reconciles the
  exact spending Stop and verified native closure before recording an interrupted finish.
  Restart keeps uncertain runs occupied. Automatic routine execution remains disabled.
- A stopped routine now releases its occupied slot when its native turn completes before
  Stop reaches the computer. Restart and repeated cleanup keep one interrupted finish.
