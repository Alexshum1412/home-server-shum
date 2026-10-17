/**
 * «Оливия»: explains the server's state to the admin with fixed rules over data that is already
 * measured. No AI model, no guessing: every finding comes from a concrete value.
 */
import type { AuditEntry, OliviaFinding, ServiceStatus, SystemResponse } from '../../../shared/api.ts';

export interface DiagnoseInput {
  /** The admin view of GET /api/system. */
  system: SystemResponse;
  services: readonly ServiceStatus[];
  /** Recent audit entries (newest first); only the last 24 h are used. */
  audit: readonly AuditEntry[];
  now: Date;
  backupRunning: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const FAILED_LOGINS_WARN = 20;

export function diagnose(input: DiagnoseInput): OliviaFinding[] {
  const { system, services } = input;
  const out: OliviaFinding[] = [];
  const jellyfin = system.programs.value?.find((p) => p.name === 'jellyfin');
  const media = services.find((s) => s.id === 'media');

  if (system.programs.value === null) {
    out.push({
      id: 'supervisor',
      level: 'warning',
      title: 'Супервизор не работает',
      explanation:
        'Программа, которая следит за порталом и кинотеатром и перезапускает их после сбоя, сейчас не запущена. Если что-то упадёт, само оно не поднимется.',
      suggestion:
        'Запустите scripts\\start.cmd на домашнем компьютере (он запустит супервизор) и проверьте автозапуск: scripts\\status.cmd.',
      action: null,
    });
  }

  if (jellyfin?.state === 'backoff') {
    out.push({
      id: 'jellyfin-crash',
      level: 'error',
      title: 'Кинотеатр падает и перезапускается',
      explanation: `Jellyfin завершился с ошибкой и перезапускается автоматически (сбоев с момента запуска супервизора: ${jellyfin.restarts}).`,
      suggestion:
        'Если сбои повторяются, перезапуск вручную обычно не помогает — посмотрите журналы: C:\\FamilyServer\\data\\dashboard\\logs\\supervisor.log и C:\\FamilyServer\\data\\jellyfin\\log.',
      action: 'restart-jellyfin',
    });
  } else if (jellyfin?.state === 'stopped') {
    out.push({
      id: 'jellyfin-stopped',
      level: 'warning',
      title: 'Кинотеатр остановлен',
      explanation: 'Jellyfin остановлен вручную, семья не может смотреть фильмы.',
      suggestion: 'Запустите его снова, если остановка не была намеренной.',
      action: 'start-jellyfin',
    });
  } else if (
    jellyfin?.state === 'running' &&
    media &&
    (media.state === 'offline' || media.state === 'degraded')
  ) {
    out.push({
      id: 'jellyfin-not-answering',
      level: 'warning',
      title: 'Кинотеатр запущен, но не отвечает',
      explanation: `Процесс Jellyfin работает, но проверка /health не проходит (${media.detail ?? media.message}). После запуска это нормально в первые минуты; если дольше — программа зависла.`,
      suggestion:
        'Подождите пару минут. Супервизор сам перезапустит зависшую программу после трёх неудачных проверок; можно перезапустить и сейчас.',
      action: 'restart-jellyfin',
    });
  } else if (jellyfin && jellyfin.restarts >= 3) {
    out.push({
      id: 'jellyfin-unstable',
      level: 'warning',
      title: 'Кинотеатр работает нестабильно',
      explanation: `Jellyfin перезапускался после сбоев ${jellyfin.restarts} раз(а) с момента запуска супервизора.`,
      suggestion:
        'Посмотрите журналы Jellyfin (C:\\FamilyServer\\data\\jellyfin\\log) — частая причина: повреждённый файл в библиотеке или нехватка памяти.',
      action: null,
    });
  }

  const backup = system.backup;
  if (backup.state === 'failed') {
    out.push({
      id: 'backup-failed',
      level: 'error',
      title: 'Последнее резервное копирование не удалось',
      explanation: backup.message,
      suggestion:
        'Частая причина — флешка «reserve» отключена или переполнена. Подключите её и сделайте копию заново.',
      action: 'run-backup',
    });
  } else if (backup.state === 'stale') {
    out.push({
      id: 'backup-stale',
      level: 'warning',
      title: 'Резервная копия устарела',
      explanation: backup.message,
      suggestion: 'Ночная копия делается, только пока в Windows выполнен вход. Сделайте копию сейчас.',
      action: 'run-backup',
    });
  } else if (backup.state === 'not_configured') {
    out.push({
      id: 'backup-not-configured',
      level: 'warning',
      title: 'Резервное копирование не настроено',
      explanation: 'Копий семейных данных нет.',
      suggestion: 'Включите ежедневную копию: scripts\\backup-schedule.cmd, затем сделайте первую копию.',
      action: 'run-backup',
    });
  } else if (backup.state === 'ok' && !backup.restoreTested) {
    out.push({
      id: 'restore-untested',
      level: 'warning',
      title: 'Восстановление из копии не проверялось',
      explanation: 'Копии делаются, но проверки, что из них можно восстановиться, ещё не было.',
      suggestion: 'Выполните scripts\\backup.cmd test-restore на домашнем компьютере.',
      action: null,
    });
  }

  for (const volume of system.volumes) {
    if (!volume.lowSpace) continue;
    out.push({
      id: `space-${volume.path}`,
      level: 'warning',
      title: `Мало места на ${volume.path}`,
      explanation:
        volume.freeBytes === null
          ? 'Свободного места мало.'
          : `Свободно ${Math.round(volume.freeBytes / 1024 ** 3)} ГБ.`,
      suggestion:
        'Освободите место вручную: очистите корзины в C:\\FamilyData (папки .trash), старые загрузки или фильмы. Оливия ничего не удаляет сама.',
      action: null,
    });
  }

  for (const disk of system.physicalDisks.value ?? []) {
    if (disk.health !== 'warning' && disk.health !== 'unhealthy') continue;
    out.push({
      id: `disk-${disk.model}`,
      level: 'warning',
      title: `Диск «${disk.model}» требует внимания`,
      explanation: disk.note ?? `Windows сообщает: ${disk.rawHealth || 'неизвестное состояние'}.`,
      suggestion:
        'Не инициализируйте и не форматируйте этот диск. Убедитесь, что копии свежие (docs/runbooks/second-disk.md).',
      action: null,
    });
  }

  const ts = system.tailscale.state;
  if (ts === 'stopped' || ts === 'needs_login' || ts === 'not_installed') {
    out.push({
      id: 'tailscale',
      level: 'warning',
      title: 'Удалённый доступ не работает',
      explanation: system.tailscale.reason ?? 'Tailscale не подключён.',
      suggestion:
        'Откройте приложение Tailscale на домашнем компьютере и войдите. Настройки сети Оливия не меняет.',
      action: null,
    });
  }

  const memory = system.memory;
  if (memory.usedBytes.value !== null && memory.usedBytes.value / memory.totalBytes > 0.92) {
    out.push({
      id: 'memory',
      level: 'warning',
      title: 'Почти закончилась оперативная память',
      explanation: `Занято ${Math.round((memory.usedBytes.value / memory.totalBytes) * 100)} % памяти. Компьютер может тормозить.`,
      suggestion: 'Закройте лишние программы на компьютере. Перекодирование в Jellyfin тоже занимает память.',
      action: null,
    });
  }

  const others = services.filter(
    (s) => s.id !== 'media' && (s.state === 'offline' || s.state === 'degraded'),
  );
  if (others.length > 0) {
    out.push({
      id: 'services-down',
      level: 'warning',
      title: 'Не отвечают сервисы',
      explanation: others.map((s) => `«${s.name}»: ${s.message}`).join('; '),
      suggestion: 'Проверьте, запущены ли эти программы. Можно повторить проверку.',
      action: 'recheck-services',
    });
  }

  const since = input.now.getTime() - DAY_MS;
  const recent = input.audit.filter((e) => Date.parse(e.time) >= since);
  const failures = recent.filter((e) => e.action === 'login.failure').length;
  const blocked = recent.filter((e) => e.action === 'login.blocked').length;
  if (failures >= FAILED_LOGINS_WARN || blocked > 0) {
    out.push({
      id: 'logins',
      level: 'warning',
      title: 'Много неудачных попыток входа',
      explanation: `За сутки: неудачных входов — ${failures}, блокировок — ${blocked}.`,
      suggestion:
        'Посмотрите журнал ниже: с каких адресов и для каких логинов. Если это не забывчивость родственника — смените пароль этого логина (scripts\\user.cmd passwd <логин>).',
      action: null,
    });
  }

  if (input.backupRunning) {
    out.push({
      id: 'backup-running',
      level: 'ok',
      title: 'Идёт резервное копирование',
      explanation: 'Копия записывается прямо сейчас.',
      suggestion: 'Ничего делать не нужно.',
      action: null,
    });
  }

  if (out.length === 0) {
    out.push({
      id: 'all-good',
      level: 'ok',
      title: 'Всё в порядке',
      explanation: 'Программы работают, копии свежие, места достаточно, подозрительных входов нет.',
      suggestion: 'Ничего делать не нужно.',
      action: null,
    });
  }
  return out;
}
