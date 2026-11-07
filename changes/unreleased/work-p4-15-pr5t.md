- Private memory collection now checks the pinned native runtime and matching silo before
  returning an unfinished recall result. Missing native files and changed protection refuse.
  Native recall qualification remains NOT RUN and admission stays disabled.
