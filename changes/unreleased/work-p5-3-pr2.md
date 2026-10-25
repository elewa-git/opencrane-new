The installer refuses incomplete CloudNativePG operator and credential settings before Helm runs. It checks the rendered PostgreSQL image against the exact reviewed digest and keeps private values out of dependency errors. The shipped image review still refuses CNPG installation.

Installer test fixtures copy the same checked set of modules, including the CloudNativePG checks. A missing local import now names the file to add before a fixture runs.
