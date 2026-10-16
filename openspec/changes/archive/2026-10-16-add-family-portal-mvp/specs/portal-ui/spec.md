# Spec Delta

## Purpose

Описывает, как семья видит и использует портал: страницы, навигацию, понятные состояния, адаптивность от телефона до телевизора, доступность и установку как приложения (PWA).

## ADDED Requirements

### Requirement: Family-first home page
The home page SHALL greet the signed-in user by display name, show a prominent cinema action, cards for photos, files, downloads, print and calendar, a compact server status row, and confirmed alerts in plain Russian.

#### Scenario: Cinema not installed
- **WHEN** the media service is `not_configured`
- **THEN** the cinema action is not a working link, and the card explains in plain words that the cinema is not set up yet

#### Scenario: Cinema online
- **WHEN** the media service is `online`
- **THEN** the cinema action opens its `openUrl` in a new tab

### Requirement: Status is never colour-only
Every state SHALL be conveyed by text and an icon in addition to colour.

#### Scenario: Offline badge
- **WHEN** a service is offline
- **THEN** its badge shows an icon and the word «Не отвечает», not only a red dot

### Requirement: Loading, empty, error and offline states
Every data view SHALL have distinct loading, error (with retry) and empty states. When the portal cannot reach the server, a banner SHALL say that the home server is unreachable, and last known data SHALL be marked with its age.

#### Scenario: Server unreachable
- **WHEN** API requests fail with a network error or time out (10 s)
- **THEN** the UI shows «Нет связи с домашним сервером» and a retry action, without crashing

### Requirement: Responsive layout
The UI SHALL work without horizontal page scrolling at 375, 390, 430, 768, 1024 and 1440 CSS px, using a bottom tab bar on narrow screens and a side navigation on wide screens, with touch targets of at least 44 px.

#### Scenario: Narrow phone
- **WHEN** the viewport is 375 px wide
- **THEN** the document width does not exceed the viewport and the primary navigation is reachable

### Requirement: Accessibility
The UI SHALL use semantic landmarks and headings, labelled form fields, visible keyboard focus, sufficient contrast, and SHALL respect `prefers-reduced-motion`. Automated accessibility checks SHALL report no serious or critical violations on the main pages.

#### Scenario: Keyboard navigation
- **WHEN** a user tabs through the home page
- **THEN** every interactive element receives a visible focus indicator in a logical order

### Requirement: Role-aware navigation
The administration section SHALL appear only for admins; family users navigating to it directly SHALL see an access-denied message (the server still enforces 403).

#### Scenario: Family opens /admin
- **WHEN** a family user opens `/admin`
- **THEN** the page states that administration is available only to administrators

### Requirement: Installable app shell without external runtime requests
The portal SHALL provide a web app manifest, icons and a service worker that caches only the app shell (never API responses), and SHALL make no runtime requests to third-party hosts (fonts, icons, CDNs).

#### Scenario: Install on phone
- **WHEN** the portal is opened over the tailnet HTTPS address
- **THEN** the browser can add it to the home screen with the name «Семейный сервер»

### Requirement: Demo labelling
When the server is in demo mode, the UI SHALL show a persistent «Демо-режим» banner and mark demo values.

#### Scenario: Demo mode on
- **WHEN** the session reports `demo: true`
- **THEN** a banner explains that the data is not real
