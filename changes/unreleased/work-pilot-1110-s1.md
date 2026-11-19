The local Helm package can use a provider connected in Settings with
`models.mode: provider`. It keeps provider keys on private persistent storage shared
only by the server and models containers, skips the stand-in and includes HTTPS
trust for real replies. The default install keeps its existing stand-in behaviour.
