- Allow admins to set and restore the saved installation payer's spending ceiling.
  Daily fresh budget checks now use a real group and shared assistant, and restore
  those same limits after checking saved budget notices.
  Its audit check follows older change-history pages when newer grants fill the first page.
- Wait for the first provider default before the fresh check selects it, avoiding
  a startup conflict with the background setup worker.
