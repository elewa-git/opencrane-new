Private memory checks now measure each process's executable, owner and control group
alongside its process ID, and refuse changed identities across live reads.
The computer image carries the native process reader. Memory admission stays disabled.
