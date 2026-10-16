/**
 * Backups of the family server: portal data, settings (.env), the code as a git bundle and the
 * Tailscale Serve config — to every BACKUP_TARGETS folder (main disk + flash drive "reserve").
 *   node server/src/cli/backup.ts run | list | verify [snapshotDir] | prune | test-restore
 *   node server/src/cli/backup.ts restore <snapshotDir> --to <emptyDir> [--no-repo]
 * Exit code: 0 — everything ok, 1 — any failure, 2 — usage error. Never prints file contents.
 */
import path from 'node:path';
import { BackupError, describeError } from '../backup/files.ts';
import { restoreSnapshot, testRestore } from '../backup/restore.ts';
import { applyRetention, listSnapshots } from '../backup/retention.ts';
import {
  type BackupDeps,
  type BackupSettings,
  backupSettingsFromConfig,
  defaultBackupDeps,
  runBackup,
} from '../backup/run.ts';
import { readManifest, verifySnapshot } from '../backup/snapshot.ts';
import { resolveTargets } from '../backup/targets.ts';
import { type Config, loadConfig } from '../config.ts';
import { formatBytes } from '../lib/format.ts';

class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const OK = 'ОК     ';
const FAIL = 'ОШИБКА ';

function usage(config: Config | null): string {
  const lines = [
    'Резервное копирование семейного сервера: данные портала, настройки (.env), код (git bundle)',
    'и настройки Tailscale Serve. Копии проверяются по контрольным суммам SHA-256.',
    '',
    'Команды (из папки проекта): scripts\\backup.cmd <команда> или node server/src/cli/backup.ts <команда>',
    '  run                                   сделать копию во все места хранения',
    '  list                                  показать копии в каждом месте',
    '  verify [папка-копии]                  проверить копию (без папки — самые свежие в каждом месте)',
    '  restore <папка-копии> --to <папка>    восстановить копию в новую пустую папку (--no-repo — без кода)',
    '  test-restore                          пробное восстановление свежих копий во временную папку',
    '  prune                                 удалить старые копии сверх BACKUP_KEEP',
    '',
    'Восстановление никогда не пишет в рабочую папку данных портала. Чтобы вернуть данные:',
    '  1) restore <папка-копии> --to <новая пустая папка>;',
    '  2) остановите сервер (scripts\\stop.cmd);',
    '  3) замените файлы в папке данных файлами из <новая папка>\\data (sessions.json не восстанавливается —',
    '     все войдут заново);',
    '  4) запустите сервер (scripts\\start.cmd) и проверьте вход.',
  ];
  if (config) {
    lines.push(
      '',
      `Места хранения (BACKUP_TARGETS): ${config.backupTargets.join('; ')}`,
      `Хранится копий в каждом месте (BACKUP_KEEP): ${config.backupKeep}`,
      `Папка данных (DASHBOARD_DATA_DIR): ${config.dataDir}`,
    );
  }
  return lines.join('\n');
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['to']);
const BOOLEAN_FLAGS = new Set(['no-repo', 'help']);

function parseArgs(argv: string[]): ParsedArgs {
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
        let value: string | undefined;
        if (eq === -1) {
          i += 1;
          value = argv[i];
        } else {
          value = arg.slice(eq + 1);
        }
        if (value === undefined || value.trim() === '')
          throw new CliError(`Для --${name} нужно значение.`, 2);
        flags.set(name, value);
      } else if (BOOLEAN_FLAGS.has(name) && eq === -1) {
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

const pad = (n: number) => String(n).padStart(2, '0');

function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'дата неизвестна';
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function printWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) console.log(`Замечание: ${warning}`);
}

async function commandRun(settings: BackupSettings, deps: BackupDeps): Promise<number> {
  const mirror = settings.gitPush
    ? ` + копия кода на GitHub (${settings.gitPush.remote}/${settings.gitPush.branch})`
    : '';
  console.log(`Резервное копирование: мест хранения — ${settings.targets.length}${mirror}.`);
  const result = await runBackup(settings, deps);
  for (const target of result.targets) {
    if (target.optional) {
      // The GitHub mirror: only committed code; a failure is a remark, not a failed backup.
      console.log(
        target.ok
          ? `${OK}${target.name}: ${target.root ?? ''} (коммит ${target.snapshot ?? '?'})`
          : `ЗАМЕЧ. ${target.name}: ${target.error ?? 'неизвестная ошибка'}`,
      );
    } else if (target.ok) {
      const where = path.join(target.root ?? '', target.snapshot ?? '');
      console.log(`${OK}${target.name}: ${where} (${formatBytes(target.sizeBytes ?? 0)}), проверено`);
    } else {
      console.log(`${FAIL}${target.name}: ${target.error ?? 'неизвестная ошибка'}`);
    }
  }
  printWarnings(result.warnings);
  if (result.ok) {
    console.log('Резервное копирование завершено: все копии записаны и проверены.');
    return 0;
  }
  console.error('Резервное копирование завершилось с ошибками — см. строки «ОШИБКА» выше.');
  return 1;
}

async function commandList(settings: BackupSettings, deps: BackupDeps): Promise<number> {
  let exitCode = 0;
  for (const target of await resolveTargets(settings.targets, deps)) {
    if (target.root === null) {
      console.log(`${target.name}: ${target.error}`);
      exitCode = 1;
      continue;
    }
    console.log(`${target.name} — ${target.root}`);
    let snapshots: Awaited<ReturnType<typeof listSnapshots>>;
    try {
      snapshots = await listSnapshots(target.root);
    } catch (error) {
      console.log(`  не удалось прочитать папку: ${describeError(error)}`);
      exitCode = 1;
      continue;
    }
    if (snapshots.length === 0) console.log('  копий пока нет');
    for (const snapshot of snapshots) {
      const { manifest } = await readManifest(snapshot.dir);
      if (!manifest) {
        console.log(`  ${snapshot.name}  manifest.json не читается`);
        continue;
      }
      const size = manifest.files.reduce((sum, file) => sum + file.size, 0);
      const code = manifest.repo.ok ? 'с кодом' : 'без кода';
      console.log(
        `  ${snapshot.name}  ${formatLocal(manifest.createdAt)}  файлов: ${manifest.files.length}  ${formatBytes(size)}  ${code}`,
      );
    }
  }
  return exitCode;
}

async function verifyOne(dir: string, settings: BackupSettings, deps: BackupDeps): Promise<boolean> {
  const result = await verifySnapshot(dir, { gitExe: settings.gitExe, tempDir: deps.tempDir });
  if (result.ok) {
    console.log(
      `${OK}${result.dir}: в порядке (файлов: ${result.fileCount}, ${formatBytes(result.sizeBytes)})`,
    );
  } else {
    console.log(`${FAIL}${result.dir}:`);
    for (const problem of result.problems) console.log(`  - ${problem}`);
  }
  printWarnings(result.warnings);
  return result.ok;
}

async function commandVerify(
  settings: BackupSettings,
  deps: BackupDeps,
  snapshotDir: string | undefined,
): Promise<number> {
  if (snapshotDir !== undefined) return (await verifyOne(path.resolve(snapshotDir), settings, deps)) ? 0 : 1;
  let allOk = true;
  for (const target of await resolveTargets(settings.targets, deps)) {
    if (target.root === null) {
      console.log(`${FAIL}${target.name}: ${target.error}`);
      allOk = false;
      continue;
    }
    const [newest] = await listSnapshots(target.root);
    if (!newest) {
      console.log(`${FAIL}${target.name}: копий нет (${target.root})`);
      allOk = false;
      continue;
    }
    console.log(`${target.name}:`);
    if (!(await verifyOne(newest.dir, settings, deps))) allOk = false;
  }
  return allOk ? 0 : 1;
}

async function commandRestore(
  config: Config,
  settings: BackupSettings,
  deps: BackupDeps,
  args: ParsedArgs,
): Promise<number> {
  const snapshotDir = args.positional[1];
  const to = args.flags.get('to');
  if (!snapshotDir || typeof to !== 'string') {
    throw new CliError('Укажите копию и пустую папку: restore <папка-копии> --to <папка>', 2);
  }
  const result = await restoreSnapshot(snapshotDir, to, {
    gitExe: settings.gitExe,
    tempDir: deps.tempDir,
    liveDataDir: config.dataDir,
    cloneRepo: !args.flags.has('no-repo'),
  });
  console.log(
    `Восстановлено в ${result.dest}: файлов ${result.fileCount} (${formatBytes(result.sizeBytes)}), проверено.`,
  );
  if (result.repoHead) {
    console.log(`Код: ${path.join(result.dest, 'repo')} (коммит ${result.repoHead.slice(0, 12)}).`);
  }
  printWarnings(result.warnings);
  console.log(
    `Данные портала — в ${path.join(result.dest, 'data')}. Рабочая папка (${config.dataDir}) не изменялась; ` +
      'заменяйте её содержимое только при остановленном сервере (см. --help).',
  );
  if (result.repoError !== null) {
    console.error(
      `Код не восстановлен (данные восстановлены): файл ${path.join(result.dest, 'repo.bundle')} можно развернуть позже командой git clone.`,
    );
    return 1;
  }
  return 0;
}

async function commandTestRestore(settings: BackupSettings, deps: BackupDeps): Promise<number> {
  const result = await testRestore(settings, deps);
  for (const target of result.targets) {
    if (target.ok) {
      const code = target.repoHead ? `, код: коммит ${target.repoHead.slice(0, 12)}` : '';
      console.log(`${OK}${target.name}: ${target.snapshot} восстановлена и проверена${code}`);
    } else {
      const which = target.snapshot ? ` (${target.snapshot})` : '';
      console.log(`${FAIL}${target.name}${which}: ${target.error ?? 'неизвестная ошибка'}`);
    }
  }
  printWarnings(result.warnings);
  if (result.ok) {
    console.log('Проверка восстановления пройдена: копии читаются и совпадают с контрольными суммами.');
    return 0;
  }
  console.error('Проверка восстановления не пройдена — см. строки «ОШИБКА» выше.');
  return 1;
}

async function commandPrune(settings: BackupSettings, deps: BackupDeps): Promise<number> {
  let exitCode = 0;
  for (const target of await resolveTargets(settings.targets, deps)) {
    if (target.root === null) {
      console.log(`${FAIL}${target.name}: ${target.error}`);
      exitCode = 1;
      continue;
    }
    try {
      const result = await applyRetention(target.root, {
        keep: settings.keep,
        dataDir: settings.dataDir,
        clock: deps.clock,
      });
      console.log(
        `${result.errors.length === 0 ? OK : FAIL}${target.name}: осталось копий ${result.kept.length}, ` +
          `удалено старых ${result.removed.length}, незавершённых ${result.removedPartials.length}`,
      );
      for (const error of result.errors) console.log(`  - ${error}`);
      if (result.errors.length > 0) exitCode = 1;
    } catch (error) {
      console.log(`${FAIL}${target.name}: ${describeError(error)}`);
      exitCode = 1;
    }
  }
  return exitCode;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [command] = args.positional;
  if (args.flags.has('help') || command === 'help') {
    let config: Config | null = null;
    try {
      config = loadConfig(process.env);
    } catch {
      // Help is shown even with a broken configuration.
    }
    console.log(usage(config));
    return 0;
  }
  if (!command) {
    console.log(usage(null));
    throw new CliError('Не указана команда.', 2);
  }
  const known = ['run', 'list', 'verify', 'restore', 'test-restore', 'prune'];
  if (!known.includes(command)) {
    throw new CliError(`Неизвестная команда «${command}». Справка: node server/src/cli/backup.ts --help`, 2);
  }

  const config = loadConfig(process.env);
  const settings = backupSettingsFromConfig(config);
  const deps = defaultBackupDeps(config);
  switch (command) {
    case 'run':
      return commandRun(settings, deps);
    case 'list':
      return commandList(settings, deps);
    case 'verify':
      return commandVerify(settings, deps, args.positional[1]);
    case 'restore':
      return commandRestore(config, settings, deps, args);
    case 'test-restore':
      return commandTestRestore(settings, deps);
    default:
      return commandPrune(settings, deps);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
    } else if (error instanceof BackupError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      console.error(`Ошибка: ${describeError(error)}`);
      process.exitCode = 1;
    }
  },
);
