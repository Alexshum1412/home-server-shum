# family-planner delta

## ADDED Requirements

### Requirement: Family tasks and shopping lists
Signed-in users SHALL keep tasks in personal or shared lists. A personal list and its tasks SHALL be visible only to its owner, administrators included. A task MAY have a date, a time, a repeat, an assignee and a list. A shopping list SHALL accept one item per line.

#### Scenario: Personal list
- **WHEN** a user creates a personal list with a task
- **THEN** no other user, administrators included, sees the list or the task, in search or elsewhere

### Requirement: Repeats and reminders
A repeating task SHALL move to its next date when it is ticked off. A task with a date SHALL produce a reminder notification at its time, or in the morning when no time is given, once.

#### Scenario: Weekly task
- **WHEN** a weekly task is ticked off
- **THEN** it stays in the list with the date a week later and the person who did it is shown

#### Scenario: One reminder
- **WHEN** the watcher runs twice for the same due task
- **THEN** only one notification exists