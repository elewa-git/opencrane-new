Chat participants can read saved take-control status. Only the requester sees their command and affected turns. The HTTP request route validates access and retries, but stays switched off until returning control and recovery are available.

Status includes saved pause success and failure. Identical requests arriving together return the same saved command. CSRF checks compare fixed-length token bytes in constant time.
