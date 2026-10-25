The local package can render a PostgreSQL primary and standby through CloudNativePG,
with separate storage, required node separation and a private primary-only Service.
The default install stays unchanged. Missing credential references or a reviewed
compatible image refuse preflight; operator setup and live recovery remain untested.
