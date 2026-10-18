# family-chat Specification

## Purpose
Семейный чат, звонки и уведомления внутри портала: переписку видят только участники, медиа звонков идёт между устройствами, человек сам выбирает, о чём ему сообщать.

## Requirements

### Requirement: Conversations belong to their members
A conversation, its messages and its attachments SHALL be visible only to its members. For anybody else, including an administrator, the server SHALL answer «not found» for the conversation, its messages and its attachment addresses.

#### Scenario: An administrator outside the chat
- **WHEN** an administrator who is not a member requests a private chat's attachment address
- **THEN** the server answers 404

#### Scenario: A person who left a group
- **WHEN** a person has left a group and asks for its messages
- **THEN** the server answers 404

### Requirement: Attachments are files, never programs
A message MAY carry one file or picture up to the configured size; the server SHALL refuse programs and scripts and SHALL check free disk space before accepting the file.

#### Scenario: A program is sent
- **WHEN** a person attaches `setup.exe`
- **THEN** the server refuses it with a plain explanation and nothing is stored

### Requirement: Messages arrive at once and are not lost
New messages, read marks and call signals SHALL reach open pages through a server-to-page event stream; after a broken connection the page SHALL reload what it shows so that nothing is missed. A message that could not be sent SHALL stay on the screen with a way to send it again.

#### Scenario: Reading clears the badge
- **WHEN** a person opens a conversation that has unread messages
- **THEN** the unread counter of that conversation clears and the sender sees who has read the message

### Requirement: Calls between up to four people
A call SHALL connect at most four people, voice or video, with the media going between the devices and the portal only relaying the signals. An unanswered call SHALL stop ringing after a fixed time and leave a line in the conversation.

#### Scenario: A fifth person
- **WHEN** a fifth person tries to join a running call
- **THEN** the join is refused and the call continues

#### Scenario: Blocked camera
- **WHEN** the browser blocks the camera and the microphone
- **THEN** the page says so in plain words and the other person keeps ringing

### Requirement: Notifications the person chose
A person SHALL choose which kinds of events they are told about (messages, calls, downloads, problems, printing) and whether the text of a message may appear in a notification. Web Push SHALL be encrypted for the receiving device and sent only to addresses of the browsers' own push services.

#### Scenario: Previews off
- **WHEN** a person has not allowed previews and receives a message
- **THEN** the notification says only that a new message has arrived
