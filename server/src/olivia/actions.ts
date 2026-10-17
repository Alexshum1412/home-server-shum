/**
 * The only things «Оливия» can do. The list is fixed in code: no command, path or argument ever
 * comes from a request, a finding text or an AI model. Each action checks that it applies to the
 * current state, needs the admin's confirmation and is written to the audit log.
 */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { OliviaActionId, OliviaActionView, SystemResponse } from '../../../shared/api.ts';
import { REPO_ROOT } from '../lib/version.ts';
import { sendCommand } from '../supervisor/main.ts';

export interface ActionContext {
  system: SystemResponse;
  backupRunning: boolean;
}

export interface ActionDeps {
  dataDir: string;
  supervisorPipe: string;
  recheckServices: () => Promise<void>;
  /** Injectable for tests. */
  send?: typeof sendCommand;
  startBackup?: () => Promise<void>;
}

interface ActionDef {
  title: string;
  confirmText: string;
  /** Why the action cannot run now, or null when it may. */
  blockedBecause(ctx: ActionContext): string | null;
  run(deps: ActionDeps): Promise<string>;
}

function jellyfinOf(ctx: ActionContext) {
  return ctx.system.programs.value?.find((p) => p.name === 'jellyfin');
}

async function supervisor(deps: ActionDeps, cmd: 'restart' | 'start', app: string): Promise<void> {
  const send = deps.send ?? sendCommand;
  const answer = (await send(deps.supervisorPipe, { cmd, app }, 120_000)) as { ok?: boolean; error?: string };
  if (!answer.ok) throw new Error(answer.error ?? 'супервизор отказал');
}

/** Starts `backup.cmd run` as a separate process (fixed arguments, no shell), output to backup.log. */
async function startBackupProcess(dataDir: string): Promise<void> {
  const logDir = path.join(dataDir, 'logs');
  await mkdir(logDir, { recursive: true });
  const log = openSync(path.join(logDir, 'backup.log'), 'a');
  const child = spawn(
    process.execPath,
    ['--env-file-if-exists=.env', path.join('server', 'src', 'cli', 'backup.ts'), 'run'],
    { cwd: REPO_ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true, shell: false },
  );
  child.unref();
}

export const OLIVIA_ACTIONS: Record<OliviaActionId, ActionDef> = {
  'restart-jellyfin': {
    title: 'Перезапустить кинотеатр',
    confirmText: 'Перезапустить Jellyfin? Кто сейчас смотрит фильм, увидит паузу на полминуты.',
    blockedBecause: (ctx) => (jellyfinOf(ctx) ? null : 'Jellyfin не находится под управлением супервизора'),
    async run(deps) {
      await supervisor(deps, 'restart', 'jellyfin');
      return 'Кинотеатр перезапущен. Через полминуты он снова будет отвечать.';
    },
  },
  'start-jellyfin': {
    title: 'Запустить кинотеатр',
    confirmText: 'Запустить Jellyfin?',
    blockedBecause: (ctx) => {
      const jf = jellyfinOf(ctx);
      if (!jf) return 'Jellyfin не находится под управлением супервизора';
      return jf.state === 'stopped' ? null : 'Кинотеатр не остановлен';
    },
    async run(deps) {
      await supervisor(deps, 'start', 'jellyfin');
      return 'Кинотеатр запускается.';
    },
  },
  'run-backup': {
    title: 'Сделать резервную копию сейчас',
    confirmText:
      'Сделать резервную копию сейчас? Кинотеатр остановится на несколько секунд, копирование займёт от минуты.',
    blockedBecause: (ctx) => (ctx.backupRunning ? 'Копирование уже идёт' : null),
    async run(deps) {
      await (deps.startBackup ?? (() => startBackupProcess(deps.dataDir)))();
      return 'Копирование запущено. Результат появится в «Состоянии системы» через несколько минут.';
    },
  },
  'recheck-services': {
    title: 'Проверить сервисы ещё раз',
    confirmText: 'Проверить все сервисы сейчас?',
    blockedBecause: () => null,
    async run(deps) {
      await deps.recheckServices();
      return 'Сервисы проверены.';
    },
  },
};

export function isOliviaAction(id: string): id is OliviaActionId {
  return Object.hasOwn(OLIVIA_ACTIONS, id);
}

export function actionViews(ctx: ActionContext): OliviaActionView[] {
  return (Object.keys(OLIVIA_ACTIONS) as OliviaActionId[]).map((id) => {
    const def = OLIVIA_ACTIONS[id];
    const reason = def.blockedBecause(ctx);
    return { id, title: def.title, confirmText: def.confirmText, allowed: reason === null, reason };
  });
}
