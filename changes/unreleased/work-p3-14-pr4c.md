- Spending Stops and approval checks keep moving while a computer waits to acknowledge
  an uploaded file. The chat's turn still waits for the receipt, including after reconnect.
- A slow chat history read leaves spending Stops and approval checks in other chats
  free to continue. Repeated polls share each unfinished Stop check, and shutdown
  waits for those checks to finish.
