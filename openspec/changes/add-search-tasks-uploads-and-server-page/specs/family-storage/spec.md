# family-storage delta

## ADDED Requirements

### Requirement: Uploads that survive a broken connection
A large file SHALL be uploaded in pieces under an upload session of the person who started it. A piece that does not begin where the stored part ends SHALL be refused with the true position, so that the client continues from there. The file SHALL appear in its place only after the whole file has arrived and passed the checks of an ordinary upload, under a name that does not replace an existing file.

#### Scenario: Connection drops
- **WHEN** the connection breaks in the middle of a file and the client asks for the position
- **THEN** the client sends the rest from that position and the final file equals the original byte by byte

#### Scenario: Someone else's session
- **WHEN** another person asks for or writes to the session
- **THEN** the server answers that there is no such transfer

### Requirement: Unfinished uploads are limited and cleaned
A part that nobody finished within a day SHALL be removed, and a person SHALL NOT keep more than a fixed number of open sessions. Unfinished parts SHALL NOT appear in lists, in search or in the copies of the family's files.

#### Scenario: Abandoned part
- **WHEN** a session is older than a day
- **THEN** its part is removed by the next cleaning
### Requirement: Exact duplicates are skipped on request
Before adding photos the client SHALL be able to ask which of them the space already holds, by SHA-256 of the file as sent. Only byte-identical files SHALL be treated as equal, the person SHALL be told which were skipped and SHALL be able to add them anyway. A photo moved to the trash SHALL no longer count as present.

#### Scenario: Same photo twice
- **WHEN** a photo is added that already exists under another name
- **THEN** it is reported as already there and not stored again unless the person insists

### Requirement: Location is removed from a JPEG on request
When the person asks for it, the server SHALL store a JPEG without its EXIF location, camera data, thumbnails and comments, keeping the image, the colour profile and the orientation. Other formats SHALL be stored unchanged and the interface SHALL say so.

#### Scenario: GPS in a JPEG
- **WHEN** a JPEG with a location in its notes is added with the option on
- **THEN** the stored file contains no location and displays with the same orientation

### Requirement: The trash gives things back
Deleting SHALL move the item to the trash with a record of its name and place. The person SHALL be able to list their own trash and return an item to its old place (or to the top when the place is gone, under a free name when the name is taken). The portal SHALL NOT empty the trash.

#### Scenario: Restore
- **WHEN** a person returns a deleted file
- **THEN** it is back in its folder with the same content

### Requirement: Moving and albums
A person SHALL be able to move a file or folder to another folder of the same space, never into itself, and to keep photos in albums that are folders under `Альбомы`.

#### Scenario: Into itself
- **WHEN** a folder is moved into its own subfolder
- **THEN** the server refuses

### Requirement: A limit per person
The server MAY limit the personal space of a person. From 90 % it SHALL warn, at 100 % it SHALL refuse new files with an explanation, and the shared space SHALL NOT be limited per person.

#### Scenario: Full
- **WHEN** a person at the limit uploads a file
- **THEN** it is refused with a message that the space is full and what to do