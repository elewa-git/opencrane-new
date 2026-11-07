# File access contract

`GET /api/conversations/:conversationId/files` and
`GET /api/conversations/:conversationId/files/view` keep their current membership,
participation, join-position, private-session and file-specific checks after close.
The owner may still read a saved session file. Other participants retain only
their existing screenshot access. A removed or foreign member cannot list or
download private files.

`POST /api/conversations/:conversationId/files` still refuses a closed chat.
The file command reads the chat history, checks for a saved close, then uses one
conditional append to the conversation stream. A close or competing upload
cannot admit a later file record.
