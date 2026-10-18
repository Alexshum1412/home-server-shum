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

### Requirement: Waiting queue when the printer does not answer
When the printer does not answer, the portal SHALL keep the accepted document and let the user choose to queue it. A queued document SHALL be sent by itself only after the printer answers again, and SHALL be dropped after 24 hours. A document without that choice SHALL never be printed and SHALL be dropped after 6 hours.

#### Scenario: No choice made
- **WHEN** the printer comes back while the held document was not queued
- **THEN** nothing is printed

#### Scenario: Queued document
- **WHEN** the user queued a document and the printer answers again
- **THEN** the document is sent and the job is followed to the end
