Package installation now refuses unsafe swap and host crash dumps on every target
node before Helm runs, with exact host fixes. Operators can rerun the F1/F2 host
probes; an explicit local dev-box exception logs the risk and records it in the
installation record. Host checks never change machine settings.
