# family-storage delta

## ADDED Requirements

### Requirement: Import and export without the browser
On the server, a folder SHALL be importable into the files or photos of an existing account and a space SHALL be exportable to an empty folder. Import SHALL apply the rules of a web upload, SHALL NOT change or delete the source and SHALL NOT copy again what is already there with the same name and size.

#### Scenario: Program in the folder
- **WHEN** a folder with an `.exe` and a document is imported
- **THEN** the document is copied and the program is reported as skipped

#### Scenario: Not a photo
- **WHEN** a text file named `.jpg` is imported into photos
- **THEN** it is skipped because its content is not a picture or video
