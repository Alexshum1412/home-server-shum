import type { TorrentSpec } from '../../server/test/fixtures/torrent-builder.ts';

/** The invented torrent of the browser tests (the stand-in client knows it for magnet links). */
export const E2E_TORRENT: TorrentSpec = {
  name: 'Тестовая раздача',
  files: [
    { path: ['Фильм.mp4'], length: 8_000_000 },
    { path: ['Субтитры', 'ru.srt'], length: 20_000 },
    { path: ['установка.exe'], length: 500_000 },
  ],
  announce: 'udp://tracker.example.org:6969/announce',
};
