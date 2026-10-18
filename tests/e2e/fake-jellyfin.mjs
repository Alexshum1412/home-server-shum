// A small stand-in for Jellyfin's API (only what the portal's cinema page asks), for tests.
// Items are invented; posters are generated; the video is a 3-second test pattern made with ffmpeg.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';

export const FAKE_KEY = '0123456789abcdef0123456789abcdef';

const id = (n) => n.toString(16).padStart(32, '0');
const LIB = { movies: id(0xa1), shows: id(0xa2), books: id(0xa3), music: id(0xa4) };

/** A plain coloured PNG (the poster). */
function png(width, height, hue) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const t = y / height;
      const r = Math.round(40 + 160 * Math.abs(Math.sin((hue + t * 50) / 60)));
      const g = Math.round(60 + 120 * Math.abs(Math.cos((hue + t * 40) / 50)));
      const b = Math.round(110 + 120 * t);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ticks = (minutes) => minutes * 60 * 10_000_000;
const video = (codec, container, audio = 'aac') => ({
  Container: container,
  MediaStreams: [
    { Type: 'Video', Codec: codec, Width: 1920, Height: 1080 },
    { Type: 'Audio', Codec: audio },
  ],
});

export const ITEMS = [
  {
    Id: id(1),
    Name: 'Весёлые каникулы',
    Type: 'Movie',
    ProductionYear: 2019,
    Genres: ['Комедия', 'Семейный'],
    CommunityRating: 7.8,
    RunTimeTicks: ticks(96),
    Overview: 'Семья едет на море и по дороге теряет всё, что можно потерять.',
    Poster: true,
    parent: LIB.movies,
    MediaSources: [video('h264', 'mov,mp4,m4a,3gp,3g2,mj2')],
    file: 'video',
  },
  {
    Id: id(2),
    Name: 'Тайна старого маяка',
    Type: 'Movie',
    ProductionYear: 2021,
    Genres: ['Приключения'],
    CommunityRating: 7.1,
    RunTimeTicks: ticks(112),
    Overview: 'Двое друзей находят карту в бабушкином сундуке.',
    Poster: true,
    parent: LIB.movies,
    MediaSources: [video('h264', 'matroska,webm')],
    file: 'video',
  },
  {
    Id: id(3),
    Name: 'Звёздный курьер',
    Type: 'Movie',
    ProductionYear: 2023,
    Genres: ['Фантастика', 'Приключения'],
    CommunityRating: 8.2,
    RunTimeTicks: ticks(128),
    Overview: 'Курьер доставляет посылку через всю галактику.',
    Poster: true,
    parent: LIB.movies,
    MediaSources: [video('hevc', 'matroska,webm', 'dts')],
    file: 'video',
  },
  {
    Id: id(4),
    Name: 'Фильм без обложки',
    Type: 'Movie',
    ProductionYear: 2017,
    Genres: ['Драма'],
    RunTimeTicks: ticks(88),
    Poster: false,
    parent: LIB.movies,
    MediaSources: [video('h264', 'mov,mp4,m4a,3gp,3g2,mj2')],
    file: 'video',
  },
  {
    Id: id(10),
    Name: 'Приключения кота Мурзика',
    Type: 'Series',
    ProductionYear: 2020,
    Genres: ['Мультфильм', 'Семейный'],
    CommunityRating: 8.5,
    Overview: 'Кот Мурзик и его друзья во дворе.',
    Poster: true,
    parent: LIB.shows,
  },
  {
    Id: id(11),
    Name: 'Сезон 1',
    Type: 'Season',
    IndexNumber: 1,
    SeriesName: 'Приключения кота Мурзика',
    Poster: false,
    parent: id(10),
  },
  {
    Id: id(12),
    Name: 'Первый день во дворе',
    Type: 'Episode',
    IndexNumber: 1,
    ParentIndexNumber: 1,
    SeriesName: 'Приключения кота Мурзика',
    RunTimeTicks: ticks(22),
    Poster: false,
    parent: id(11),
    MediaSources: [video('h264', 'mov,mp4,m4a,3gp,3g2,mj2')],
    file: 'video',
  },
  {
    Id: id(13),
    Name: 'Дождливый вторник',
    Type: 'Episode',
    IndexNumber: 2,
    ParentIndexNumber: 1,
    SeriesName: 'Приключения кота Мурзика',
    RunTimeTicks: ticks(22),
    Poster: false,
    parent: id(11),
    MediaSources: [video('h264', 'mov,mp4,m4a,3gp,3g2,mj2')],
    file: 'video',
  },
  { Id: id(20), Name: 'Сказки на ночь', Type: 'Folder', Poster: true, parent: LIB.books },
  {
    Id: id(21),
    Name: 'Глава 1. Лесной гость',
    Type: 'AudioBook',
    IndexNumber: 1,
    RunTimeTicks: ticks(18),
    Poster: false,
    parent: id(20),
    MediaSources: [{ Container: 'mp3', MediaStreams: [{ Type: 'Audio', Codec: 'mp3' }] }],
    file: 'audio',
  },
  {
    Id: id(22),
    Name: 'Глава 2. Река',
    Type: 'AudioBook',
    IndexNumber: 2,
    RunTimeTicks: ticks(21),
    Poster: false,
    parent: id(20),
    MediaSources: [{ Container: 'mp3', MediaStreams: [{ Type: 'Audio', Codec: 'mp3' }] }],
    file: 'audio',
  },
  {
    Id: id(30),
    Name: 'Семейные песни',
    Type: 'MusicAlbum',
    ProductionYear: 2015,
    Genres: ['Детская'],
    Poster: true,
    parent: LIB.music,
  },
];

const dto = (item) => {
  const { Poster, parent, file, ...rest } = item;
  return { ...rest, ParentId: parent, ImageTags: Poster ? { Primary: 'tag' } : {} };
};

function wavBytes(seconds) {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds, 128);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * @param {{ port: number, videoFile: string, key?: string }} options
 * @returns {Promise<{ close: () => Promise<void>, requests: string[] }>}
 */
export async function startFakeJellyfin(options) {
  const key = options.key ?? FAKE_KEY;
  const videoBytes = readFileSync(options.videoFile);
  const audioBytes = wavBytes(2);
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const json = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') return res.end('Healthy');
    if (req.headers.authorization !== `MediaBrowser Token="${key}"`) return json({ error: 'no' }, 401);
    const q = url.searchParams;
    if (url.pathname === '/System/Info') return json({ Version: 'fake' });
    if (url.pathname === '/Library/MediaFolders') {
      return json({
        Items: [
          { Id: LIB.movies, Name: 'Фильмы', CollectionType: 'movies' },
          { Id: LIB.shows, Name: 'Сериалы', CollectionType: 'tvshows' },
          { Id: LIB.books, Name: 'Аудиокниги', CollectionType: 'books' },
          { Id: LIB.music, Name: 'Музыка', CollectionType: 'music' },
          { Id: id(0xa9), Name: 'Playlists' },
        ],
      });
    }
    if (url.pathname === '/Genres') {
      const names = [...new Set(ITEMS.flatMap((item) => item.Genres ?? []))].sort();
      return json({ Items: names.map((Name) => ({ Name })) });
    }
    if (url.pathname === '/Items') {
      const types = (q.get('IncludeItemTypes') ?? '').split(',').filter(Boolean);
      const ids = (q.get('Ids') ?? '').split(',').filter(Boolean);
      let list = ITEMS.slice();
      if (ids.length > 0) list = list.filter((item) => ids.includes(item.Id));
      if (types.length > 0) list = list.filter((item) => types.includes(item.Type));
      const parent = q.get('ParentId');
      if (parent) {
        const direct = q.get('Recursive') === 'false';
        const children = (of) => ITEMS.filter((item) => item.parent === of).map((item) => item.Id);
        const all = new Set([parent]);
        if (!direct) for (const next of all) for (const child of children(next)) all.add(child);
        list = list.filter((item) => item.parent && all.has(item.parent) && item.parent !== undefined);
      }
      const term = q.get('searchTerm')?.toLowerCase();
      if (term) list = list.filter((item) => item.Name.toLowerCase().includes(term));
      const genre = q.get('Genres');
      if (genre) list = list.filter((item) => (item.Genres ?? []).includes(genre));
      const sort = q.get('SortBy') ?? '';
      if (sort.startsWith('SortName')) list.sort((a, b) => a.Name.localeCompare(b.Name, 'ru'));
      if (sort.startsWith('IndexNumber')) list.sort((a, b) => (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
      const total = list.length;
      const start = Number(q.get('StartIndex') ?? 0);
      const limit = Number(q.get('Limit') ?? 100);
      const wantSources = (q.get('Fields') ?? '').includes('MediaSources');
      return json({
        Items: list.slice(start, start + limit).map((item) => {
          const out = dto(item);
          if (!wantSources) out.MediaSources = undefined;
          if (!(q.get('Fields') ?? '').includes('Overview')) out.Overview = undefined;
          return out;
        }),
        TotalRecordCount: total,
      });
    }
    const image = /^\/Items\/([0-9a-f]{32})\/Images\/Primary$/.exec(url.pathname);
    if (image) {
      const item = ITEMS.find((i) => i.Id === image[1]);
      if (!item?.Poster) return json({ error: 'none' }, 404);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png(120, 180, Number.parseInt(item.Id.slice(-2), 16) * 9));
    }
    const stream = /^\/(Videos|Audio)\/([0-9a-f]{32})\/stream$/.exec(url.pathname);
    if (stream) {
      const item = ITEMS.find((i) => i.Id === stream[2]);
      if (!item?.file) return json({ error: 'none' }, 404);
      const bytes = item.file === 'video' ? videoBytes : audioBytes;
      const type = item.file === 'video' ? 'video/mp4' : 'audio/wav';
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = range[1] === '' ? 0 : Number(range[1]);
        const end = range[2] === '' ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
        });
        return res.end(bytes.subarray(start, end + 1));
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' });
      return res.end(bytes);
    }
    return json({ error: 'unknown' }, 404);
  });
  await new Promise((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  return {
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
