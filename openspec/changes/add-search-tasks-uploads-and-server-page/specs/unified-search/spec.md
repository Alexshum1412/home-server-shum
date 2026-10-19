# unified-search delta

## ADDED Requirements

### Requirement: One search over what the person may see
A signed-in person SHALL be able to search films, photos, files, notes, calendar events, tasks and chats from any page. Each result SHALL be something that person may open, and the search SHALL NOT show another person's private files, notes, events, tasks or conversations, administrators included.

#### Scenario: Another person's private note
- **WHEN** a person searches for a word that occurs only in another person's private note
- **THEN** the note is not in the results

### Requirement: A slow or missing source does not hide the others
Each source SHALL answer within a fixed time limit. A source that fails or does not answer SHALL be named with a reason, and the other sources SHALL still be shown.

#### Scenario: Media server is down
- **WHEN** the media server does not answer
- **THEN** the results of the other sources are shown and the films group says it is unavailable

### Requirement: Limited load
A person SHALL NOT run more than a few searches at the same moment, and a search SHALL return a bounded number of results per source.

#### Scenario: Many searches at once
- **WHEN** a person sends more searches than allowed at the same time
- **THEN** the extra ones are refused with a clear message and the server stays responsive