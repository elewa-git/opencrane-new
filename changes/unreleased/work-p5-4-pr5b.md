Three-peer package installation now checks prepared route certificates, three eligible isolated nodes and compatibility of the exact server/web image pins before Helm runs. The shipped image remains refused; image promotion and live qualification are separate work.
Expired-certificate refusal tests use explicit past dates so their fixtures work across OpenSSL versions.
Package installation now refuses invalid mounted NATS certificates, mismatched role keys, changed connection settings or a modified storage, TLS or account policy before any Helm command.
