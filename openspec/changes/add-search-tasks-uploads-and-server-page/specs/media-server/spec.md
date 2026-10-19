# media-server delta

## ADDED Requirements

### Requirement: Personal marks and rows
A person SHALL be able to mark a title as favourite, watch later or watched. Marks and the history SHALL belong to the person and SHALL NOT be shown to others. The catalogue SHALL offer rows built from them: favourites, watch later, history, «new» (added in the last two weeks) and «for you» with the reason for each title.

#### Scenario: Marks are private
- **WHEN** one person marks a film as favourite
- **THEN** another person's favourites row does not contain it

### Requirement: Family suggestions
Any person SHALL be able to suggest a title; the whole family SHALL see the suggestions and administrators SHALL mark them added or declined.

#### Scenario: A suggestion
- **WHEN** a person suggests a film
- **THEN** it appears in the family's list and an administrator can mark it