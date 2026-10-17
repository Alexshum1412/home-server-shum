# media-server delta

## ADDED Requirements

### Requirement: Audiobooks in the media library
The media library SHALL include a library «Аудиокниги» in `C:\FamilyData\Media\Аудиокниги`, one folder per book and one file per chapter.

#### Scenario: Chapter files
- **WHEN** a book folder with audio files is scanned
- **THEN** Jellyfin lists them as audiobook items

### Requirement: Fallback player without Jellyfin
Signed-in users SHALL be able to browse and play the audio and video files of the media folder through the portal when Jellyfin is down. The folder SHALL be read-only, only playable media types SHALL be listed or served, and paths outside the folder, including through links, SHALL be refused.

#### Scenario: Seeking
- **WHEN** a player requests a byte range of a listed file
- **THEN** the server answers 206 with that range

#### Scenario: Escape attempt
- **WHEN** a path contains `..` or leads through a junction out of the folder
- **THEN** the server refuses it and serves nothing
