The separate scanner launcher can now scan bounded file bytes through its verified daemon. It checks the byte hash, running container and database age, limits results to two minutes, and stops safely on failed or cancelled requests. Upload and image consumers remain unchanged.

Scanner transport failures now immediately refuse new and pending scans, even when the failed Docker client does not close. The failed request waits for container cleanup before reporting its error.
