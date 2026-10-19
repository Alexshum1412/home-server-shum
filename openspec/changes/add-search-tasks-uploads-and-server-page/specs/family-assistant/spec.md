# family-assistant delta

## ADDED Requirements

### Requirement: The local model is protected on this computer
The local model SHALL listen only on the loopback address, SHALL require an access key kept in the data folder outside the repository, and SHALL run below normal priority. Its answer SHALL be a closed choice of a tool and words of the person's own question.

#### Scenario: Request without the key
- **WHEN** a program on the computer calls the model without the key
- **THEN** the model refuses

#### Scenario: A link the person did not write
- **WHEN** the model names an address that is not in the person's message
- **THEN** the address is dropped and the rules decide