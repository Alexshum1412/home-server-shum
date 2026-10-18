# family-assistant Specification

## Purpose
«Оливия» как помощница всей семьи: закрытый список инструментов, права спрашивающего, необязательная локальная модель, которая только выбирает инструмент и не видит данные семьи.

## Requirements

### Requirement: A closed list of tools with the asker's rights
«Оливия» SHALL answer only through a fixed list of tools (find a film, find a file or photo, free space, backup state, downloads, calendar, help, check a link). Every tool SHALL work with the rights of the person who asked: another person's private files, chats and events SHALL NOT be reachable, and downloads SHALL need the `downloads` right.

#### Scenario: A person without the right
- **WHEN** a person without the `downloads` right asks about downloads
- **THEN** the answer says how to get the right and no download data is shown

### Requirement: Nothing changes without a person's click
«Оливия» SHALL NOT start, delete or restart anything for the family. For a link she SHALL only check it and show the same confirmation as the downloads page; the download starts only when the person presses the button.

#### Scenario: A magnet link in the question
- **WHEN** an administrator asks her to download a magnet link
- **THEN** she prepares the check and the downloads queue stays unchanged until the button is pressed

### Requirement: The language model is local, optional and blind to the family's data
The language model SHALL be reachable only on this PC, SHALL only choose a tool and its words from the closed list, and SHALL NOT receive the family's data: results SHALL be written by the portal from facts. An address or a search phrase chosen by the model SHALL appear in the person's own message, otherwise it SHALL be dropped.

#### Scenario: The model invents an address
- **WHEN** the model answers with a link that is not in the person's message
- **THEN** the link is dropped and the question is answered by the rules

### Requirement: Honest when the model is absent
Without a model, or when it does not answer, «Оливия» SHALL keep answering by the rules and the page SHALL say that the model is not connected or not responding.

#### Scenario: The model is down
- **WHEN** the configured model does not answer
- **THEN** the page shows that it is not responding and clear questions are still answered

### Requirement: Questions are not written down
The audit log SHALL record only which kind of help was given, never the text of the question.

#### Scenario: A question is asked
- **WHEN** a person asks for a film
- **THEN** the log line names only the kind of help (for example `media`) and does not contain the words asked
