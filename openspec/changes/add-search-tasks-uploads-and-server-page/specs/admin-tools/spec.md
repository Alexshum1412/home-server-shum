# admin-tools delta

## ADDED Requirements

### Requirement: A page and a desktop window to control the server programs
Administrators SHALL see the server programs and start, stop or restart them from a page of the portal; the same three actions SHALL be on a window on the desktop of the computer. The actions SHALL be a closed list over known programs, SHALL be written to the audit log, and «stop» SHALL stop programs, not the operating system.

#### Scenario: Unknown program
- **WHEN** a request names a program that is not in the list
- **THEN** it is refused and nothing runs

### Requirement: Logs and reports without secrets
The last log lines and the report that can be copied SHALL pass a sanitiser that removes secrets, tokens, mail addresses, folders of users, addresses of the network, names of computers and people and the texts of messages. A test with planted values SHALL fail if any of them appears.

#### Scenario: Planted secret
- **WHEN** a log line holding a planted secret is shown or copied
- **THEN** the secret is not in the output