/**
 * `backup.ts offsite …` — the encrypted copy for outside the house.
 *   offsite init-key                     create the key once and print the recovery code (write it down)
 *   offsite recovery-code                print the recovery code of the existing key again
 *   offsite pack                         pack the newest verified copy into BACKUP_OFFSITE_DIR now
 *   offsite list                         show the encrypted files
 *   offsite verify [file]                decrypt a file end to end and check it (nothing is written)
 *   offsite test-restore [file]          restore into a temporary folder, check, remove the folder
 *   offsite restore <file> --to <dir>    restore into a new empty folder (the live data is never touched)
 * The key comes from BACKUP_KEY_FILE, or from --key-file <file>, or from --code-stdin (the recovery code on stdin).
 */
import path from 'node:path';
import { formatRecoveryCode, generateKey, readKeyFile, writeNewKeyFile } from '../backup/crypt.ts';
import { BackupError, describeError } from '../backup/files.ts';
import {
  listOffsite,
  loadKey,
  type OffsiteDeps,
  type OffsiteSettings,
  packOffsite,
  pruneOffsite,
  restoreOffsite,
  testRestoreOffsite,
  verifyOffsiteFile,
} from '../backup/offsite.ts';
import { listSnapshots } from '../backup/retention.ts';
import type { BackupDeps, BackupSettings } from '../backup/run.ts';
import { recordOffsite } from '../backup/status.ts';
import { resolveTargets } from '../backup/targets.ts';
import type { Config } from '../config.ts';
import { formatBytes } from '../lib/format.ts';

const OK = 'ОК     ';
const FAIL = 'ОШИБКА ';

export interface OffsiteCommandArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function offsiteSettings(config: Config): OffsiteSettings {
  if (config.backupOffsiteDir === null) {
    throw new BackupError(
      'Папка для зашифрованной копии не задана. Добавьте в .env строку BACKUP_OFFSITE_DIR=<полный путь к папке на внешнем диске> и повторите.',
    );
  }
  return {
    dir: config.backupOffsiteDir,
    keyFile: config.backupKeyFile,
    keep: config.backupOffsiteKeep,
    everyDays: config.backupOffsiteEveryDays,
  };
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]?.trim() ?? '';
}

/** The key: from --key-file, from the recovery code on stdin, or from the configured key file. */
async function resolveKey(config: Config, args: OffsiteCommandArgs): Promise<Buffer> {
  const keyFile = args.flags.get('key-file');
  if (typeof keyFile === 'string') return readKeyFile(path.resolve(keyFile));
  if (args.flags.has('code-stdin')) return loadKey({ keyFile: config.backupKeyFile }, await readStdinLine());
  return readKeyFile(config.backupKeyFile);
}

function offsiteDeps(settings: BackupSettings, deps: BackupDeps): OffsiteDeps {
  return {
    clock: deps.clock,
    statfs: deps.statfs,
    dataDir: settings.dataDir,
    gitExe: settings.gitExe,
    tempDir: deps.tempDir,
  };
}

async function newestFile(config: Config, given: string | undefined): Promise<string> {
  if (given) return path.resolve(given);
  const [newest] = await listOffsite(offsiteSettings(config).dir);
  if (!newest) throw new BackupError('В папке для зашифрованной копии пока нет ни одного файла');
  return newest.file;
}

export async function commandOffsite(
  config: Config,
  settings: BackupSettings,
  deps: BackupDeps,
  args: OffsiteCommandArgs,
): Promise<number> {
  const sub = args.positional[1];
  switch (sub) {
    case 'init-key': {
      const key = generateKey();
      await writeNewKeyFile(config.backupKeyFile, key);
      console.log(`Ключ шифрования создан: ${config.backupKeyFile}`);
      console.log('');
      console.log(
        'КОД ВОССТАНОВЛЕНИЯ — запишите его на бумагу и храните ОТДЕЛЬНО от диска с копиями и вне дома:',
      );
      console.log(`  ${formatRecoveryCode(key)}`);
      console.log('');
      console.log(
        'Без ключа или кода зашифрованные копии прочитать нельзя — никому, в том числе мне и разработчикам.',
      );
      console.log(
        'Код больше нигде не сохраняется. Повторно показать его можно командой recovery-code, пока цел файл ключа.',
      );
      return 0;
    }
    case 'recovery-code': {
      const key = await readKeyFile(config.backupKeyFile);
      console.log(formatRecoveryCode(key));
      return 0;
    }
    case 'list': {
      const dir = offsiteSettings(config).dir;
      const entries = await listOffsite(dir);
      console.log(`Зашифрованные копии в ${dir}:`);
      if (entries.length === 0) console.log('  пока нет');
      for (const entry of entries) console.log(`  ${entry.name}  ${formatBytes(entry.sizeBytes)}`);
      return 0;
    }
    case 'pack': {
      const offsite = offsiteSettings(config);
      const key = await resolveKey(config, args);
      let snapshotDir: string | null = null;
      for (const target of await resolveTargets(settings.targets, deps)) {
        if (target.root === null) continue;
        const [newest] = await listSnapshots(target.root);
        if (newest) {
          snapshotDir = newest.dir;
          break;
        }
      }
      if (snapshotDir === null) throw new BackupError('Нет ни одной локальной копии: сначала backup.cmd run');
      const result = await packOffsite(snapshotDir, offsite, key, offsiteDeps(settings, deps));
      const pruned = await pruneOffsite(offsite.dir, offsite.keep, deps.clock, [result.name]);
      const at = deps.clock().toISOString();
      await recordOffsite(settings.dataDir, {
        configured: true,
        lastPackAt: at,
        lastFile: result.name,
        sizeBytes: result.sizeBytes,
        verifiedAt: at,
        error: null,
      });
      console.log(
        result.existed
          ? `${OK}Для копии ${result.snapshot} зашифрованный файл уже есть: ${result.file}`
          : `${OK}Записан и проверен: ${result.file} (${formatBytes(result.sizeBytes)}, файлов ${result.files})`,
      );
      if (pruned.removed.length > 0)
        console.log(`Удалено старых зашифрованных копий: ${pruned.removed.length}`);
      console.log(
        'Унесите диск из дома или убедитесь, что папка синхронизируется надёжным способом. Ключ и код восстановления храните отдельно.',
      );
      return 0;
    }
    case 'verify': {
      const key = await resolveKey(config, args);
      const file = await newestFile(config, args.positional[2]);
      try {
        const check = await verifyOffsiteFile(file, key);
        await recordOffsite(settings.dataDir, {
          configured: true,
          verifiedAt: deps.clock().toISOString(),
          error: null,
        });
        console.log(
          `${OK}${file}: целостность и подлинность подтверждены (файлов ${check.files}, ${formatBytes(check.bytes)})`,
        );
        return 0;
      } catch (error) {
        console.log(`${FAIL}${file}: ${describeError(error)}`);
        return 1;
      }
    }
    case 'test-restore': {
      const key = await resolveKey(config, args);
      const file = await newestFile(config, args.positional[2]);
      try {
        const result = await testRestoreOffsite(file, key, offsiteDeps(settings, deps));
        await recordOffsite(settings.dataDir, {
          configured: true,
          testedAt: deps.clock().toISOString(),
          error: null,
        });
        console.log(
          `${OK}${file}: восстановлено во временную папку и сверено с контрольными суммами (файлов ${result.files}, ${formatBytes(result.bytes)}); папка удалена`,
        );
        return 0;
      } catch (error) {
        console.log(`${FAIL}${file}: ${describeError(error)}`);
        return 1;
      }
    }
    case 'restore': {
      const file = args.positional[2];
      const to = args.flags.get('to');
      if (!file || typeof to !== 'string') {
        throw new BackupError('Укажите файл и новую пустую папку: offsite restore <файл> --to <папка>');
      }
      const key = await resolveKey(config, args);
      const result = await restoreOffsite(file, key, to, offsiteDeps(settings, deps));
      console.log(
        `${OK}Восстановлено в ${result.dest}: файлов ${result.files} (${formatBytes(result.bytes)}), проверено по manifest.json.`,
      );
      console.log(
        `Данные портала — в ${path.join(result.dest, 'data')}. Рабочая папка (${config.dataDir}) не изменялась; заменяйте её только при остановленном сервере (backup.cmd --help).`,
      );
      return 0;
    }
    default:
      throw new BackupError(
        'Команда offsite: init-key | recovery-code | pack | list | verify [файл] | test-restore [файл] | restore <файл> --to <папка>',
      );
  }
}
