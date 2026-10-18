# printing delta

## ADDED Requirements

### Requirement: Waiting queue when the printer does not answer
When the printer does not answer, the portal SHALL keep the accepted document and let the user choose to queue it. A queued document SHALL be sent by itself only after the printer answers again, and SHALL be dropped after 24 hours. A document without that choice SHALL never be printed and SHALL be dropped after 6 hours.

#### Scenario: No choice made
- **WHEN** the printer comes back while the held document was not queued
- **THEN** nothing is printed

#### Scenario: Queued document
- **WHEN** the user queued a document and the printer answers again
- **THEN** the document is sent and the job is followed to the end
