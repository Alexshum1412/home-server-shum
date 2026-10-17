# portal-ui delta

## ADDED Requirements

### Requirement: Folder state is in the address and lists belong to their folder
The space, folder and month of the file and photo pages SHALL be part of the page address, so that Back goes up one level. A list SHALL never be shown under the heading of another folder: while a folder loads, or after it failed to load, the previous folder's list SHALL NOT be displayed.

#### Scenario: Back button
- **WHEN** a user opens a folder and presses Back
- **THEN** the parent folder is shown

#### Scenario: Folder does not open
- **WHEN** the list request of a folder fails
- **THEN** the page shows the problem and not the previous list

### Requirement: Results next to the user's attention
The result of an action on a long list SHALL appear in a fixed message above the tab bar. Uploads SHALL show progress and SHALL warn before the page is closed.

#### Scenario: Rename far down a list
- **WHEN** a user renames the last of many files
- **THEN** the confirmation is visible without scrolling
