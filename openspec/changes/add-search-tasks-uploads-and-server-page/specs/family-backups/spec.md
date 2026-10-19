# family-backups delta

## ADDED Requirements

### Requirement: An encrypted copy for outside the house
The newest verified snapshot SHALL be packed into one authenticated encrypted file in a folder the owner chooses, using a key kept outside the repository and the data folder, with a recovery code for the owner. The file SHALL be checked by decrypting it, and a wrong key, a damaged byte, a cut-off or extended file or swapped parts SHALL be refused. Restoring SHALL always go into a new empty folder and be compared with the snapshot's own manifest.

#### Scenario: Wrong key
- **WHEN** a file is opened with another key
- **THEN** it is refused with a message that says the key does not fit and nothing is written

#### Scenario: Restore
- **WHEN** an encrypted copy is restored into an empty folder
- **THEN** every file matches the checksums of the snapshot