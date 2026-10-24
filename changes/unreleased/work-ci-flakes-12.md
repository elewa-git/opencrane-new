- Make the nightly memory recovery test wait for the failed job to be removed after
  its result is saved, so a busy worker does not cause a false failure.
