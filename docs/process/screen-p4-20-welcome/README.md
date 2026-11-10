# Saved welcome screen captures

The capture script opens `/welcome` with intercepted saved server responses.
It does not start a development stack or make a model call. The PNG files cover
the active question, resumed question, completed welcome, archived display and
reduced motion at 1280 and 390 pixels. Denied access has its own two captures.

The active frames follow the supplied question and dock layout. The completed
frames show the saved answer, assistant confirmation, crease and read-only action.
The archived frame keeps those words and replaces the action note. The phone
captures use a browser viewport; the keyboard capture shrinks that viewport to
560 pixels and checks that the composer remains visible. It does not draw a
device keyboard. The script
checks for horizontal overflow, 44-pixel controls and absent private content
after denied access. The new page has simpler top navigation and typography than
the supplied frames, while keeping their message order and completion layout.
