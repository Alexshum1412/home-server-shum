/**
 * First-time setup of the local Jellyfin (scripts\jellyfin-setup.cmd), idempotent:
 *   1. the startup wizard: Russian UI/metadata, the owner's admin account with a generated password
 *      (printed once, never stored), remote access off (Jellyfin is reached only via Tailscale Serve);
 *   2. an API key «FamilyServer» saved to <data dir>\jellyfin-api.json (supervisor: clean shutdown,
 *      portal: status details);
 *   3. libraries for the folders under C:\FamilyData\Media, without the CPU-heavy trickplay and
 *      chapter images; a library scan.
 * Talks only to http://127.0.0.1:8096; nothing here comes from a browser request.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { generatePassword } from '../auth/passwords.ts';
import { loadConfig } from '../config.ts';
import { writeJsonAtomic } from '../lib/json-store.ts';
import { JELLYFIN_PORT, jellyfinPaths, readJellyfinApiKey } from '../supervisor/apps.ts';

export const API_KEY_APP = 'FamilyServer';
const CLIENT_HEADER =
  'MediaBrowser Client="FamilyServer", Device="setup", DeviceId="family-server-setup", Version="1.0"';

export interface LibrarySpec {
  name: string;
  folder: string;
  collectionType: 'movies' | 'tvshows' | 'music' | 'homevideos' | 'books';
}

export const LIBRARIES: readonly LibrarySpec[] = [
  { name: 'Фильмы', folder: 'Фильмы', collectionType: 'movies' },
  { name: 'Сериалы', folder: 'Сериалы', collectionType: 'tvshows' },
  { name: 'Мультфильмы', folder: 'Мультфильмы', collectionType: 'movies' },
  { name: 'Домашнее видео', folder: 'Домашнее видео', collectionType: 'homevideos' },
  { name: 'Музыка', folder: 'Музыка', collectionType: 'music' },
  // Audiobooks: a folder per book, one file per chapter (the portal's fallback player reads the same folder).
  { name: 'Аудиокниги', folder: 'Аудиокниги', collectionType: 'books' },
];

export interface SetupOptions {
  baseUrl: string;
  adminName: string;
  mediaRoot: string;
  apiKeyFile: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface SetupResult {
  wizardCompleted: boolean;
  /** Set only when the wizard ran now: the generated admin password, to be shown once. */
  adminPassword: string | null;
  apiKeySaved: boolean;
  librariesAdded: string[];
}

class SetupError extends Error {}

export async function setupJellyfin(options: SetupOptions): Promise<SetupResult> {
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => undefined);
  const call = async (method: string, url: string, body?: unknown, token?: string): Promise<Response> => {
    const res = await doFetch(`${options.baseUrl}${url}`, {
      method,
      headers: {
        Authorization: token ? `${CLIENT_HEADER}, Token="${token}"` : CLIENT_HEADER,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new SetupError(`${method} ${url.split('?')[0]}: HTTP ${res.status}`);
    return res;
  };

  const info = (await (await call('GET', '/System/Info/Public')).json()) as {
    StartupWizardCompleted?: boolean;
    Version?: string;
  };
  log(`Jellyfin ${info.Version ?? '?'} на ${options.baseUrl}`);
  const result: SetupResult = {
    wizardCompleted: false,
    adminPassword: null,
    apiKeySaved: false,
    librariesAdded: [],
  };

  let token: string | null = readJellyfinApiKey(options.apiKeyFile);
  if (!info.StartupWizardCompleted) {
    const password = generatePassword();
    await call('POST', '/Startup/Configuration', {
      ServerName: 'Семейный сервер',
      UICulture: 'ru',
      MetadataCountryCode: 'RU',
      PreferredMetadataLanguage: 'ru',
    });
    await call('GET', '/Startup/User');
    await call('POST', '/Startup/User', { Name: options.adminName, Password: password });
    await call('POST', '/Startup/RemoteAccess', { EnableRemoteAccess: false });
    await call('POST', '/Startup/Complete');
    result.wizardCompleted = true;
    result.adminPassword = password;
    log(`Мастер первого запуска пройден, администратор Jellyfin — ${options.adminName}`);
    const auth = (await (
      await call('POST', '/Users/AuthenticateByName', { Username: options.adminName, Pw: password })
    ).json()) as { AccessToken?: string };
    if (!auth.AccessToken) throw new SetupError('Jellyfin не выдал токен входа');
    token = auth.AccessToken;
  } else if (!token) {
    throw new SetupError(
      `Мастер Jellyfin уже пройден, а ключ API (${options.apiKeyFile}) не найден. Создайте ключ в Jellyfin ` +
        `(Панель управления → Ключи API, приложение «${API_KEY_APP}») и сохраните его в этот файл как {"apiKey":"…"}.`,
    );
  }

  // API key for the supervisor and the portal.
  if (!readJellyfinApiKey(options.apiKeyFile)) {
    const keys = async () =>
      (
        (await (await call('GET', '/Auth/Keys', undefined, token ?? undefined)).json()) as {
          Items?: Array<{ AccessToken?: string; AppName?: string }>;
        }
      ).Items ?? [];
    let key = (await keys()).find((k) => k.AppName === API_KEY_APP)?.AccessToken;
    if (!key) {
      await call('POST', `/Auth/Keys?app=${encodeURIComponent(API_KEY_APP)}`, undefined, token ?? undefined);
      key = (await keys()).find((k) => k.AppName === API_KEY_APP)?.AccessToken;
    }
    if (!key || !/^[0-9a-f]{32}$/i.test(key)) throw new SetupError('Не удалось получить ключ API Jellyfin');
    await writeJsonAtomic(options.apiKeyFile, {
      apiKey: key,
      app: API_KEY_APP,
      createdAt: new Date().toISOString(),
    });
    result.apiKeySaved = true;
    token = key;
    log(`Ключ API «${API_KEY_APP}» сохранён: ${options.apiKeyFile}`);
  }

  const existing = (await (
    await call('GET', '/Library/VirtualFolders', undefined, token ?? undefined)
  ).json()) as Array<{
    Name?: string;
  }>;
  const names = new Set(existing.map((folder) => folder.Name));
  for (const lib of LIBRARIES) {
    if (names.has(lib.name)) continue;
    const folder = path.join(options.mediaRoot, lib.folder);
    await fsp.mkdir(folder, { recursive: true });
    const query = new URLSearchParams({
      name: lib.name,
      collectionType: lib.collectionType,
      paths: folder,
      refreshLibrary: 'false',
    });
    await call(
      'POST',
      `/Library/VirtualFolders?${query.toString()}`,
      {
        LibraryOptions: {
          EnableRealtimeMonitor: true,
          // Trickplay previews and chapter images re-encode whole films: hours of CPU on an i5-6400.
          EnableTrickplayImageExtraction: false,
          ExtractTrickplayImagesDuringLibraryScan: false,
          EnableChapterImageExtraction: false,
          ExtractChapterImagesDuringLibraryScan: false,
          PreferredMetadataLanguage: 'ru',
          MetadataCountryCode: 'RU',
          SaveLocalMetadata: false,
        },
      },
      token ?? undefined,
    );
    result.librariesAdded.push(lib.name);
    log(`Библиотека «${lib.name}» → ${folder}`);
  }
  await call('POST', '/Library/Refresh', undefined, token ?? undefined);
  log('Запущено сканирование библиотек');
  return result;
}

async function main(argv: string[]): Promise<number> {
  const config = loadConfig(process.env);
  const paths = jellyfinPaths(process.env, config);
  const adminIndex = argv.indexOf('--admin');
  const adminName = adminIndex >= 0 ? (argv[adminIndex + 1] ?? '') : 'alex';
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(adminName)) {
    console.error('Имя администратора: латиница, цифры, «.», «_», «-» (2–32 символа).');
    return 2;
  }
  const mediaRoot = process.env.MEDIA_ROOT?.trim() || `${process.env.SystemDrive || 'C:'}\\FamilyData\\Media`;
  try {
    const result = await setupJellyfin({
      baseUrl: `http://127.0.0.1:${JELLYFIN_PORT}`,
      adminName,
      mediaRoot,
      apiKeyFile: paths.apiKeyFile,
      log: (line) => console.log(line),
    });
    if (result.adminPassword) {
      console.log('');
      console.log(`  Jellyfin — логин:  ${adminName}`);
      console.log(`  Jellyfin — пароль: ${result.adminPassword}`);
      console.log('');
      console.log(
        'Пароль показан один раз и нигде не сохранён. Смените его в Jellyfin: значок профиля → Профиль → Пароль.',
      );
    }
    console.log(
      result.librariesAdded.length > 0
        ? `Готово. Новые библиотеки: ${result.librariesAdded.join(', ')}.`
        : 'Готово: всё уже было настроено.',
    );
    return 0;
  } catch (error) {
    console.error(`Настройка Jellyfin не удалась: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
