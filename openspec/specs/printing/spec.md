# printing Specification

## Purpose
Печать PDF и фотографий из портала на домашний принтер — для разрешённых членов семьи, с проверкой и подтверждением, без обработки файлов на сервере.

## Requirements

### Requirement: Checked and confirmed printing
Only users with the `print` right (admins always) SHALL print. A document SHALL be accepted only when its content is PDF or JPEG and within the size limit, SHALL be validated by the printer before anything is printed, and SHALL be sent only after the user confirms.

#### Scenario: Program renamed to .pdf
- **WHEN** a file starting with "MZ" is uploaded as `doc.pdf`
- **THEN** the server answers 415 and nothing is sent to the printer

#### Scenario: Confirmed job
- **WHEN** a user confirms a validated PDF
- **THEN** the printer receives exactly the uploaded bytes and the job is followed until it is printed, after which the spooled file is deleted

### Requirement: The server never processes the document
The server SHALL NOT open, render, convert or execute uploaded documents; it SHALL only forward the bytes to the configured printer address.

#### Scenario: HTML upload
- **WHEN** an HTML file is uploaded for printing
- **THEN** it is refused as an unsupported format

### Requirement: Honest printer state
The printer state SHALL come from the printer in the background without delaying a page, and toner levels SHALL be shown only when the printer reports them.

#### Scenario: Toner unknown
- **WHEN** the printer reports marker levels of -2
- **THEN** the page says the printer does not report toner levels and shows no percentage
