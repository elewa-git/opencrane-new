# Saved welcome screen captures

The capture script opens `/welcome` with intercepted saved server responses.
It does not start a development stack or make a model call. The PNG files cover
the active question, resumed question, completed welcome, archived display and
reduced motion at 1280 and 390 pixels. Denied access has its own two captures.

The active frame starts in this browser visit. The resumed frame loads the saved
question in a new browser page and shows “Welcome back”. The completed frames
show the saved answer, assistant confirmation, completion time, crease and
read-only action.
The archived frame keeps those words and replaces the action note. The phone
captures use a browser viewport; the keyboard capture shrinks that viewport to
560 pixels and checks that the composer remains visible. It does not draw a
device keyboard. The script checks for horizontal overflow, 44-pixel controls
and absent private content
after denied access. The desktop captures include the session rail. The phone
captures keep the text and send action inside one composer frame.
