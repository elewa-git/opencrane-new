Personal assistants use their approved onboarding persona and receive instructions
that explain their real tools, file sharing and current network limits. Shared
assistants and unattended routines receive their own instructions. Private Memory
restrictions stay unchanged. Automatic model retries remain disabled because an
ordinary chat replay can charge twice.

The application package includes the assistant instruction helper, templates and
licence notices, with exact source hashes checked before image approval.
The package also uses the rebuilt computer image, so these instructions reach
ordinary chat models. Its image pin must match the released computer template.
The package check also rejects computer source changed since that image was checked.
The computer image licence review assigns both retained Codex prompt notices
under Apache-2.0, so the package gate accepts them without relaxing its checks.

Native licence review input hashes are checked before building the application
package. The assistant shell test runs in the CI job that builds its computer image.
It checks the image's installed source and the instructions sent upstream on new
and resumed threads, including after a computer restart.

Private thread starts keep their previous configuration without the new assistant
instructions. Memory-free resume tests check the complete new configuration.
