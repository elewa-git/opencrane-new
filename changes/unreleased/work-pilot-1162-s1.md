Prepare a fresh Ubuntu VM for the package with a guarded k3s and gVisor bootstrap, local
persistent storage and disabled swap and crash dumps. Preparation defaults to a dry run and
requires `--apply` to change the host. Disposable container checks
cover existing-runtime refusals and repeated configuration. Record the measured one-person
package CPU, memory and disk demand; these observations do not qualify a minimum machine size.

Keep the packaged website available when a desktop connection fails. Share the WebSocket
connection handling with the development static server and close both peers.

The 24 November one-person packaged journey passed on approved rebased product source
`9cb7e672c`: sign-in, chat, PDF upload, decoded desktop viewing, history refusal and
spending at 1280 and 390 pixels. Whole-node peaks were 2.739 cores / 5.46 GiB including
swap; the package peaked at 2.274 cores / 2.96 GiB working set. Installation was not
sampled; these observations do not qualify a minimum machine size. Real Ubuntu bootstrap
and reboot are NOT RUN.
