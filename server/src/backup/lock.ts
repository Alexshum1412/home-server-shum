/**
 * One backup run at a time (the nightly task, a manual run and «Оливия» may overlap):
 * <data dir>\run\backup.lock holds the PID of the running copy; a lock left by a dead process is
 * taken over.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { processAlive } from '../system/programs.ts';
import { BackupError } from './files.ts';

export function backupLockPath(dataDir: string): string {
  return path.join(dataDir, 'run', 'backup.lock');
}

async function holder(file: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

/** True while another live process holds the backup lock. */
export async function backupRunning(dataDir: string, alive = processAlive): Promise<boolean> {
  const pid = await holder(backupLockPath(dataDir));
  return pid !== null && pid !== process.pid && alive(pid);
}

/** Takes the lock or throws «Копирование уже идёт»; resolves with the release function. */
export async function acquireBackupLock(dataDir: string, alive = processAlive): Promise<() => Promise<void>> {
  const file = backupLockPath(dataDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.writeFile(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
        flag: 'wx',
      });
      return async () => {
        if ((await holder(file)) === process.pid) await fsp.rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = await holder(file);
      if (pid !== null && alive(pid)) {
        throw new BackupError(`Резервное копирование уже идёт (процесс ${pid}). Дождитесь его окончания.`);
      }
      await fsp.rm(file, { force: true }); // left by a crashed run
    }
  }
  throw new BackupError('Не удалось занять блокировку резервного копирования');
}
