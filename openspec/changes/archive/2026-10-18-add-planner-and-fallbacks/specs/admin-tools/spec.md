# admin-tools delta

## ADDED Requirements

### Requirement: Diagnosis without the portal
A command on the server SHALL check the portal, the supervisor, Jellyfin, remote access, disks, backups, the printer and the Windows protection settings without using the portal, change nothing, and report the result with an exit code.

#### Scenario: Portal down
- **WHEN** the portal does not answer and the diagnosis is run
- **THEN** it reports an error for the portal with the command that restarts it and still reports the rest

### Requirement: Optional local model only re-words findings
«Оливия» MAY use a local language model reachable only on the same PC. The model SHALL receive one finding of the rules without addresses or folders, SHALL NOT choose or run actions, and its answer SHALL be shown as cleaned text marked as machine-made. Without the model everything SHALL work.

#### Scenario: Model on another host
- **WHEN** the model address is not on this PC
- **THEN** the configuration is rejected

#### Scenario: Model is down
- **WHEN** the model does not answer
- **THEN** the administrator is told so and the rules keep working
