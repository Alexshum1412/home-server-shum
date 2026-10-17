# downloads delta

## Purpose

Очередь загрузок портала: семья ставит прямые ссылки на файлы на скачивание в свою папку на домашнем сервере — с правами, подтверждением, лимитами и без доступа к домашней сети.

## ADDED Requirements

### Requirement: Right and confirmation
Only users with the `downloads` right (admins always) SHALL use the queue. A download SHALL start only after the user confirmed the result of a link check that names the file, size and site; the check id SHALL be single-use, bound to the user and short-lived.

#### Scenario: No right
- **WHEN** a family member without the right checks a link
- **THEN** the server answers 403 and the page explains that the administrator grants the right

#### Scenario: Confirmed download
- **WHEN** a user checks a link and confirms it
- **THEN** a task is queued and the file is saved byte for byte into the user's own «Загрузки» folder

### Requirement: No access to the home network
The queue SHALL fetch only from public internet addresses over HTTP(S): loopback, private, tailnet, link-local and special ranges and home host names SHALL be refused before connecting and on every redirect.

#### Scenario: Redirect into the LAN
- **WHEN** a public link redirects to `http://192.168.1.1/...`
- **THEN** the check fails with 403 `private_address` and nothing is fetched from the LAN

#### Scenario: Name resolving to this PC
- **WHEN** a link uses a name that resolves to 127.0.0.1
- **THEN** the connection is refused by the lookup guard

### Requirement: Safe storage and limits
Files SHALL be written only to the owner's folder with sanitised names; program and script types SHALL be refused; completed files SHALL carry the Mark of the Web. A file over the size limit or a disk below the free-space reserve SHALL stop the download with a clear message.

#### Scenario: Program file
- **WHEN** the link points to `setup.exe`
- **THEN** the check fails with 422 `blocked_type`

#### Scenario: Disk nearly full
- **WHEN** free space minus the file size is below the reserve
- **THEN** the download is not started and the server answers 507 `no_space`

### Requirement: Control of a running download
Users SHALL see progress and SHALL be able to pause, resume and cancel their own downloads; resume SHALL continue from the received bytes when the site supports ranges and the file is unchanged; cancel SHALL delete the partial file. Other members SHALL NOT see or control them; admins see all.

#### Scenario: Pause and resume
- **WHEN** a user pauses a running download and resumes it
- **THEN** the download continues from where it stopped and the final file is identical to the source

#### Scenario: Someone else's task
- **WHEN** a member tries to cancel another member's download
- **THEN** the server answers 404 and the task is unchanged
