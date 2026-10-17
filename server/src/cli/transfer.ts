/**
 * Files and photos in and out of the family storage from the server console — the second way next
 * to the «Файлы» and «Фото» pages (works when the portal or the phone's browser upload fails).
 *   node server/src/cli/transfer.ts import <папка> --user <логин> [--root files|photos] [--space personal|shared] [--to <папка>] [--dry-run]
 *   node server/src/cli/transfer.ts export --user <логин> --to <новая-папка> [--root files|photos] [--space personal|shared] [--from <папка>]
 * Exit code: 0 — all ok, 1 — error, 2 — usage error, 3 — done, but some files failed.
 */
import { createUserStore, normaliseUsername } from '../auth/users.ts';
import { loadConfig } from '../config.ts';
import { statfsFree } from '../downloads/manager.ts';
import { createStorage } from '../files/storage.ts';
import { exportSpace, importFolder } from '../files/transfer.ts';
import { formatBytes } from '../lib/format.ts';
import { systemClock } from '../lib/time.ts';

class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const USAGE = [
  'Перенос файлов и фото в хранилище семьи и обратно — с флешки, с телефона по кабелю, из папки.',
  '',
  'Команды (из папки проекта):',
  '  scripts\\import.cmd <папка> --user <логин> [--root files|photos] [--space personal|shared] [--to <папка>] [--dry-run]',
  '      скопировать содержимое папки в «Файлы» (по умолчанию) или в «Фото» этого пользователя;',
  '      исходная папка не меняется; уже добавленные файлы (то же имя и размер) повторно не копируются.',
  '  scripts\\export.cmd --user <логин> --to <новая-папка> [--root files|photos] [--space personal|shared] [--from <папка>]',
  '      скопировать файлы из хранилища в новую или пустую папку (например, на флешку).',
  '',
  'Те же правила, что при загрузке через портал: программы и скрипты (.exe, .bat, .ps1 …) не принимаются,',
  'в «Фото» принимаются только настоящие фото и видео, имена приводятся к безопасным, место на диске',
  'не опускается ниже допустимого. Фото раскладываются по месяцам по дате файла.',
  'Только на самом сервере: команды работают с папками этого компьютера и не открыты через портал.',
].join('\n');

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['user', 'root', 'space', 'to', 'from']);
const BOOL_FLAGS = new Set(['dry-run', 'help']);

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '-h') {
      flags.set('help', true);
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
        if (value === undefined) throw new CliError(`Для --${name} нужно значение.`, 2);
        flags.set(name, value);
      } else if (BOOL_FLAGS.has(name) && eq === -1) {
        flags.set(name, true);
      } else {
        throw new CliError(`Неизвестный параметр: ${arg}`, 2);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function flag(args: Parsed, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

async function run(argv: string[]): Promise<number> {
  const args = parse(argv);
  const [command, folder] = args.positional;
  if (!command || command === 'help' || args.flags.has('help')) {
    console.log(USAGE);
    return command || args.flags.has('help') ? 0 : 2;
  }
  if (command !== 'import' && command !== 'export') {
    throw new CliError(`Неизвестная команда «${command}». Справка: scripts\\import.cmd --help`, 2);
  }
  const login = flag(args, 'user');
  if (!login) throw new CliError('Укажите пользователя: --user <логин>.', 2);
  const rootName = flag(args, 'root') ?? 'files';
  if (rootName !== 'files' && rootName !== 'photos') throw new CliError('--root: files или photos.', 2);
  const spaceName = flag(args, 'space') ?? 'personal';
  if (spaceName !== 'personal' && spaceName !== 'shared')
    throw new CliError('--space: personal или shared.', 2);

  const config = loadConfig(process.env);
  const users = createUserStore(config.dataDir, { clock: systemClock, reloadIntervalMs: 0 });
  await users.reload();
  const user = await users.findByUsername(login);
  if (!user)
    throw new CliError(
      `Пользователь «${normaliseUsername(login)}» не найден (список: scripts\\user.cmd list).`,
    );

  const storage = createStorage({
    filesRoot: config.filesDir,
    photosRoot: config.photosDir,
    minFreeBytes: config.minFreeBytes,
    maxUploadBytes: config.uploadMaxFileBytes,
    freeBytes: statfsFree,
  });
  const where = `${rootName === 'photos' ? 'Фото' : 'Файлы'}, ${spaceName === 'shared' ? 'общее' : 'личное'}, пользователь ${user.username}`;

  if (command === 'import') {
    if (!folder) throw new CliError('Укажите папку, откуда копировать: import <папка> --user <логин>.', 2);
    const dryRun = args.flags.has('dry-run');
    console.log(`${dryRun ? 'Проверка (ничего не копируется)' : 'Копирование'}: «${folder}» → ${where}`);
    const report = await importFolder({
      storage,
      username: user.username,
      root: rootName,
      space: spaceName,
      source: folder,
      to: flag(args, 'to') ?? '',
      dryRun,
      onItem: (line) => console.log(`  ${line}`),
    });
    console.log('');
    console.log(
      `${dryRun ? 'Будет добавлено' : 'Добавлено'}: ${report.imported} (${formatBytes(report.bytes)}). ` +
        `Уже были на месте: ${report.existing}. Пропущено: ${report.skipped.length}. Не удалось: ${report.failed.length}.`,
    );
    for (const item of report.skipped) console.log(`  пропущен «${item.name}»: ${item.reason}`);
    for (const item of report.failed) console.error(`  ОШИБКА «${item.name}»: ${item.reason}`);
    if (!dryRun && report.imported > 0 && rootName === 'photos') {
      console.log('Миниатюры появятся, когда кто-нибудь откроет этот месяц в разделе «Фото».');
    }
    if (!dryRun)
      console.log('Исходная папка не изменена: удалять оттуда файлы можно только после проверки в портале.');
    return report.failed.length > 0 ? 3 : 0;
  }

  const destination = flag(args, 'to');
  if (!destination) throw new CliError('Укажите новую или пустую папку: --to <папка>.', 2);
  console.log(`Копирование из хранилища (${where}) → «${destination}»`);
  const report = await exportSpace({
    storage,
    username: user.username,
    root: rootName,
    space: spaceName,
    from: flag(args, 'from') ?? '',
    destination,
    onItem: (line) => console.log(`  ${line}`),
  });
  console.log('');
  console.log(
    `Скопировано: ${report.files} (${formatBytes(report.bytes)}). Не удалось: ${report.failed.length}.`,
  );
  for (const item of report.failed) console.error(`  ОШИБКА «${item.name}»: ${item.reason}`);
  console.log('Файлы в хранилище не изменены.');
  return report.failed.length > 0 ? 3 : 0;
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
    } else {
      console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
);
