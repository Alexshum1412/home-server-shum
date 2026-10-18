# family-planner Specification

## Purpose
Семейный календарь и заметки внутри портала: общие планы, личные записи, запасной путь без портала.

## Requirements

### Requirement: Shared and private calendar events
Signed-in users SHALL add calendar events visible to the whole family or private to the author. A private event SHALL be visible only to its author, administrators included. Only the author or an administrator SHALL change or delete a visible event.

#### Scenario: Private event
- **WHEN** a user saves an event marked private
- **THEN** other users, including administrators, neither see it in the calendar or the exported file nor can change it

#### Scenario: Someone else's family event
- **WHEN** a family member tries to change an event of another person
- **THEN** the server answers 403 and the event is unchanged

### Requirement: Repeats without time zones
An event SHALL have a calendar date and an optional wall-clock time without a time zone. Events MAY repeat weekly, monthly or yearly; a date that does not exist in a month or year SHALL be skipped. A multi-day event SHALL NOT repeat.

#### Scenario: Monthly event on the 31st
- **WHEN** an event starts on 31 January and repeats monthly
- **THEN** it appears in March and not in February

### Requirement: Calendar file as the second way
The calendar SHALL be downloadable as an iCalendar file with the events the user may see. A damaged calendar data file SHALL NOT be overwritten.

#### Scenario: Export
- **WHEN** a user requests the calendar file
- **THEN** it contains the family events and the user's private events with escaped text and no other person's private events

### Requirement: Notes are ordinary files
Notes SHALL be plain text files in the folder «Заметки» of the personal or shared space, so they appear in the file manager and in backups. A save SHALL be refused when the note changed since it was opened. A deleted note SHALL go to the trash.

#### Scenario: Two editors
- **WHEN** a second person saves a note that the first person changed meanwhile
- **THEN** the server answers 409 conflict and the first person's text is kept
