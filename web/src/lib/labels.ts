/**
 * Human labels for every state in the API contract. Pure data: the UI maps
 * `icon` keys to icon components, so a state is always «icon + word», never colour only.
 */
import type {
  AlertLevel,
  BackupState,
  DiskHealth,
  HealthLevel,
  PrinterState,
  ProgramState,
  Role,
  ServiceKind,
  ServiceState,
  ServiceStatus,
  TailscaleState,
} from '../../../shared/api.ts';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
export type StatusIcon = 'ok' | 'warn' | 'bad' | 'offline' | 'dashed' | 'minus' | 'unknown' | 'info' | 'busy';

export interface StatusView {
  label: string;
  tone: Tone;
  icon: StatusIcon;
}

const NO_DATA: StatusView = { label: 'Нет данных', tone: 'neutral', icon: 'unknown' };

/** The four summary levels of the server. */
export const HEALTH_LEVEL: Record<HealthLevel, StatusView> = {
  ok: { label: 'Работает', tone: 'ok', icon: 'ok' },
  warning: { label: 'Предупреждение', tone: 'warn', icon: 'warn' },
  error: { label: 'Ошибка', tone: 'bad', icon: 'bad' },
  unknown: { label: 'Неизвестно', tone: 'neutral', icon: 'unknown' },
};

export const PROGRAM_STATE: Record<ProgramState, StatusView> = {
  running: { label: 'Работает', tone: 'ok', icon: 'ok' },
  external: { label: 'Работает', tone: 'ok', icon: 'ok' },
  starting: { label: 'Запускается', tone: 'info', icon: 'busy' },
  backoff: { label: 'Сбой, перезапуск', tone: 'bad', icon: 'bad' },
  stopping: { label: 'Останавливается', tone: 'neutral', icon: 'busy' },
  stopped: { label: 'Остановлен', tone: 'warn', icon: 'minus' },
  unknown: { label: 'Нет данных', tone: 'neutral', icon: 'unknown' },
};

export const SERVICE_STATE: Record<ServiceState, StatusView> = {
  online: { label: 'Работает', tone: 'ok', icon: 'ok' },
  // Not «Работает…»: only an online service may be presented as available.
  degraded: { label: 'Отвечает с ошибкой', tone: 'warn', icon: 'warn' },
  offline: { label: 'Не отвечает', tone: 'bad', icon: 'bad' },
  not_configured: { label: 'Не настроено', tone: 'neutral', icon: 'dashed' },
  disabled: { label: 'Выключено', tone: 'neutral', icon: 'minus' },
  unknown: NO_DATA,
};

export const PRINTER_STATE: Record<PrinterState, StatusView> = {
  ready: { label: 'Готов к печати', tone: 'ok', icon: 'ok' },
  printing: { label: 'Печатает', tone: 'info', icon: 'busy' },
  offline: { label: 'Не в сети', tone: 'bad', icon: 'offline' },
  error: { label: 'Ошибка', tone: 'bad', icon: 'bad' },
  unknown: NO_DATA,
  not_found: { label: 'Не найден', tone: 'warn', icon: 'warn' },
  not_configured: { label: 'Не настроен', tone: 'neutral', icon: 'dashed' },
};

export const TAILSCALE_STATE: Record<TailscaleState, StatusView> = {
  running: { label: 'Работает', tone: 'ok', icon: 'ok' },
  stopped: { label: 'Выключен', tone: 'bad', icon: 'offline' },
  needs_login: { label: 'Нужен вход в Tailscale', tone: 'warn', icon: 'warn' },
  not_installed: { label: 'Не установлен', tone: 'neutral', icon: 'dashed' },
  unknown: NO_DATA,
};

export const BACKUP_STATE: Record<BackupState, StatusView> = {
  ok: { label: 'В порядке', tone: 'ok', icon: 'ok' },
  stale: { label: 'Давно не обновлялись', tone: 'warn', icon: 'warn' },
  failed: { label: 'Ошибка', tone: 'bad', icon: 'bad' },
  not_configured: { label: 'Не настроено', tone: 'warn', icon: 'dashed' },
  unknown: NO_DATA,
};

export const DISK_HEALTH: Record<DiskHealth, StatusView> = {
  healthy: { label: 'Исправен', tone: 'ok', icon: 'ok' },
  warning: { label: 'Требует внимания', tone: 'warn', icon: 'warn' },
  unhealthy: { label: 'Неисправен', tone: 'bad', icon: 'bad' },
  unknown: NO_DATA,
};

export const ALERT_LEVEL: Record<AlertLevel, StatusView & { rank: number }> = {
  critical: { label: 'Важно', tone: 'bad', icon: 'bad', rank: 0 },
  warning: { label: 'Внимание', tone: 'warn', icon: 'warn', rank: 1 },
  info: { label: 'Для сведения', tone: 'info', icon: 'info', rank: 2 },
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Администратор',
  family: 'Семья',
};

export const LOW_SPACE: StatusView = { label: 'Мало места', tone: 'warn', icon: 'warn' };
export const SPACE_OK: StatusView = { label: 'Места достаточно', tone: 'ok', icon: 'ok' };
export const SERVER_UP: StatusView = SERVICE_STATE.online;
export const SERVER_DOWN: StatusView = SERVICE_STATE.offline;
export const UNKNOWN: StatusView = NO_DATA;

const AUDIT_ACTIONS: Record<string, string> = {
  'login.success': 'Вход',
  'login.failure': 'Неудачная попытка входа',
  'login.blocked': 'Вход временно заблокирован',
  'login.rate_limited': 'Вход временно заблокирован',
  'login.ratelimit': 'Вход временно заблокирован',
  logout: 'Выход',
  'password.change': 'Смена пароля',
  'password.change_failed': 'Неудачная смена пароля',
  'download.add': 'Загрузка добавлена',
  'download.done': 'Загрузка завершена',
  'download.fail': 'Загрузка не удалась',
  'download.cancel': 'Загрузка отменена',
  'file.upload': 'Файл добавлен',
  'file.trash': 'Файл перемещён в корзину',
  'file.rename': 'Файл переименован',
  'file.mkdir': 'Создана папка',
  'olivia.action': 'Действие Оливии',
  'print.submit': 'Отправлено на печать',
  'print.cancel': 'Печать отменена',
  'print.fail': 'Печать не удалась',
  'services.refresh': 'Проверка сервисов вручную',
  'diagnostics.export': 'Выгрузка диагностики',
};

/** Russian name of an audit action; unknown codes are shown as they are. */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTIONS[action] ?? action;
}

/** Sorts alerts so that critical ones come first; stable within one level. */
export function sortAlerts<T extends { level: AlertLevel }>(alerts: readonly T[]): T[] {
  return alerts
    .map((alert, index) => ({ alert, index }))
    .sort((a, b) => ALERT_LEVEL[a.alert.level].rank - ALERT_LEVEL[b.alert.level].rank || a.index - b.index)
    .map(({ alert }) => alert);
}

/** Pages that show one service each. */
export type ServicePageKind = 'media' | 'photos' | 'files' | 'downloads';

export interface ServicePageCopy {
  kind: ServicePageKind;
  path: string;
  /** Fallback name when the service is missing from the server config. */
  name: string;
  openLabel: string;
  /** What this section is for, in plain words. */
  purpose: string;
  /** What the administrator needs to do when the service is not set up (fallback for an empty hint). */
  adminTodo: string;
}

export const SERVICE_PAGES: Record<ServicePageKind, ServicePageCopy> = {
  media: {
    kind: 'media',
    path: '/cinema',
    name: 'Кинотеатр',
    openLabel: 'Открыть кинотеатр',
    purpose:
      'Фильмы и сериалы с домашнего компьютера: смотреть на телевизоре, телефоне или ноутбуке и продолжать с того места, где остановились.',
    adminTodo:
      'Администратор устанавливает медиасервер на домашний компьютер и добавляет его адрес в настройки портала.',
  },
  photos: {
    kind: 'photos',
    path: '/photos',
    name: 'Фото',
    openLabel: 'Открыть фото',
    purpose:
      'Общий семейный фотоархив: снимки и видео со всех телефонов в одном месте, с альбомами и поиском.',
    adminTodo:
      'Администратор устанавливает фотосервис на домашний компьютер и добавляет его адрес в настройки портала.',
  },
  files: {
    kind: 'files',
    path: '/files',
    name: 'Файлы',
    openLabel: 'Открыть файлы',
    purpose: 'Общие папки семьи: документы, сканы и учебные материалы, доступные с любого устройства.',
    adminTodo:
      'Администратор выбирает и устанавливает файловый сервис, а затем добавляет его адрес в настройки портала.',
  },
  downloads: {
    kind: 'downloads',
    path: '/downloads',
    name: 'Загрузки',
    openLabel: 'Открыть загрузки',
    purpose:
      'Загрузки на домашний компьютер: поставить файл на скачивание и забрать его, когда он будет готов.',
    adminTodo:
      'Администратор устанавливает программу для загрузок, если она нужна семье, и добавляет её адрес в настройки портала.',
  },
};

/** First service of a kind from the server list, if the server knows about it. */
export function findService(services: readonly ServiceStatus[] | undefined, kind: ServiceKind) {
  return services?.find((service) => service.kind === kind);
}

/**
 * A service may be opened only when it is online and its URL is plain http(s).
 * The server already guarantees the scheme; this is defence in depth.
 */
export function openableUrl(service: Pick<ServiceStatus, 'state' | 'openUrl'> | undefined): string | null {
  if (service?.state !== 'online' || !service.openUrl) return null;
  try {
    const url = new URL(service.openUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Technical detail of a service check (e.g. «HTTP 503»): for administrators only, never for the family. */
export function adminDetail(
  service: Pick<ServiceStatus, 'detail'> | undefined,
  isAdmin: boolean,
): string | null {
  if (!isAdmin) return null;
  const detail = service?.detail?.trim();
  return detail ? detail : null;
}
