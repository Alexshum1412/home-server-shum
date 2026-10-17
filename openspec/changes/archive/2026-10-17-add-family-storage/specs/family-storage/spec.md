# family-storage delta

## Purpose

Семейные файлы и фото на домашнем сервере: личное пространство каждого и общее пространство семьи, загрузка через веб, просмотр и скачивание — без доступа к чужим личным файлам.

## ADDED Requirements

### Requirement: Private personal space
Each user's personal space SHALL be reachable only by that user through the portal; it SHALL be derived from the session and no request parameter SHALL name another user's space, for admins too. Shared space SHALL be readable and writable by every signed-in user.

#### Scenario: Admin looks for a family member's file
- **WHEN** a family member uploads a personal file and an admin lists their own personal space
- **THEN** the admin does not see the file, while a file in the shared space is visible to both

### Requirement: Paths stay inside the space
Every path SHALL be checked component by component (no `..`, drive letters, streams, reserved names) and again after resolving links; links leading outside SHALL be refused and not listed.

#### Scenario: Junction to another folder
- **WHEN** the shared space contains a junction pointing outside it
- **THEN** listing hides it and reading through it answers 403

### Requirement: Safe uploads
Uploads SHALL be raw PUT requests with `X-Upload: 1` from the portal's own origin, written as a stream to a temporary file and kept only when complete and within the size limit and free-space reserve. Programs SHALL be refused by name and by content; the photo library SHALL accept only content recognised as an image or a video.

#### Scenario: Text named like a photo
- **WHEN** a text file named `fake.jpg` is added to «Фото»
- **THEN** it is refused with 415 and the user sees «только фотографии и видео»

#### Scenario: Cross-site upload
- **WHEN** an upload arrives with a foreign Origin or without `X-Upload: 1`
- **THEN** it is refused with 403 or 415 before anything is written

### Requirement: Safe viewing and download
Files SHALL be served as downloads by default; only images, video, audio, PDF and plain text MAY be shown inline, always with a sandbox Content-Security-Policy; HTML and SVG SHALL never be shown inline. Byte ranges SHALL be supported for media.

#### Scenario: HTML file
- **WHEN** a stored `page.html` is requested with `inline=1`
- **THEN** it is sent as `application/octet-stream` attachment

### Requirement: Nothing is deleted for good
Deleting through the portal SHALL move the item to the space's trash; the portal SHALL NOT delete family files permanently.

#### Scenario: Move to trash
- **WHEN** a user deletes a shared file
- **THEN** it disappears from the folder and is kept in the shared trash with a date prefix
