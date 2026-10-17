# Design

See `docs/decisions/0008-olivia-without-ai.md`. Findings are pure functions of the admin snapshot, service statuses and the last 24 h of audit entries. Actions are looked up with `Object.hasOwn` in a fixed record, check applicability against a fresh snapshot, require `{confirm: true}`, run at most once per 30 s each and are audited (also when refused). The supervisor state file is trusted only while its PID is alive.
