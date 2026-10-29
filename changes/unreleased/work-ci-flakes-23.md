OAuth custody recovery tests prepare broker duplicate expiry before saving events,
so busy runners can check recovery without racing a change to the broker's timer.
