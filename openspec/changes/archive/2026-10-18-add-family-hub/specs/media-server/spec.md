## ADDED Requirements

### Requirement: The cinema catalogue goes through the portal
The portal SHALL list films, series, music and audiobooks with posters, descriptions and genres, support search and «Продолжить просмотр», and stream with seeking, using Jellyfin's key kept on the server; the key SHALL NOT be sent to any browser, and Jellyfin's own page SHALL stay available as the second way to watch.

#### Scenario: Posters and search
- **WHEN** a person searches the catalogue
- **THEN** matching titles are shown with their posters and a title without a poster gets an honest placeholder

#### Scenario: Jellyfin is down
- **WHEN** Jellyfin does not answer
- **THEN** the catalogue says so and the fallback player still plays plain files

### Requirement: Continue watching belongs to the person
The place where a person stopped SHALL be kept per person and SHALL NOT be visible to or overwritten by another person; a stop shorter than ten seconds SHALL NOT erase a saved place.

#### Scenario: Two people, one film
- **WHEN** two people watch the same film to different places
- **THEN** each sees «Продолжить» at their own place
