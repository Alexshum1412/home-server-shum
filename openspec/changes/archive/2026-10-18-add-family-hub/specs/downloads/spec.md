## ADDED Requirements

### Requirement: Torrents through a loopback client only
Torrents SHALL be handled by a client that listens only on this PC; its control address SHALL NOT be published by the portal, Tailscale Serve or a tunnel, and its secret SHALL NOT be passed on a command line.

#### Scenario: A non-loopback client address
- **WHEN** the configured client address is not on this PC
- **THEN** the portal refuses to start with a clear message

### Requirement: The portal reads the torrent before the client does
For a `.torrent` file or a magnet link the portal SHALL show what is inside and how much space it needs, SHALL remove web seeds and unsafe trackers, SHALL skip programs and scripts, and SHALL let the person choose only among fixed folders.

#### Scenario: A torrent with a program inside
- **WHEN** a torrent contains `setup.exe` and a film
- **THEN** only the film is downloaded and the page says one file was skipped

#### Scenario: A tracker inside the home network
- **WHEN** a torrent names a tracker whose address is inside the home network
- **THEN** that tracker is dropped

### Requirement: Honest when the client is unavailable
When the torrent client is not installed or does not answer, the downloads page SHALL say so with the reason, direct links SHALL keep working, and no torrent SHALL be shown as running.

#### Scenario: Client not installed
- **WHEN** the client program is not installed
- **THEN** the page says torrents are unavailable and offers the way to install

### Requirement: Third-party programs are installed only when verified
A program fetched from the internet by the installer SHALL be installed only after the owner confirms and only when its size and SHA-256 equal the pinned values; otherwise nothing SHALL be installed and the existing installation SHALL stay untouched.

#### Scenario: A changed file
- **WHEN** the downloaded file has a different SHA-256 from the pinned one
- **THEN** the installer stops and installs nothing
