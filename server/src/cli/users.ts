/**
 * User management on the server console (the browser can never create accounts).
 *   node server/src/cli/users.ts add <username> --name "<Display>" --role family|admin
 *   node server/src/cli/users.ts list | passwd <username> | role <username> <role> | remove <username> --yes
 * Passwords are typed twice without echo; non-interactive use requires --password-stdin.
 */
import { promises as fsp } from 'node:fs';
import { PERMISSIONS, type Permission, type Role } from '../../../shared/api.ts';
import { lastLoginOf, readLoginTimes } from '../auth/logins.ts';
import {
  checkPasswordPolicy,
  generatePassword,
  hashPassword,
  TEMPORARY_PASSWORD_TTL_MS,
} from '../auth/passwords.ts';
import {
  createUserStore,
  DISPLAY_NAME_MAX,
  needsPasswordChange,
  normaliseUsername,
  type StoredUser,
  temporaryPasswordExpired,
  USERNAME_RE,
  type UserStore,
} from '../auth/users.ts';
import { loadConfig } from '../config.ts';
import { stripBom } from '../lib/json-store.ts';
import { systemClock } from '../lib/time.ts';

class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const ROLE_LABEL: Record<Role, string> = { family: 'семья', admin: 'администратор' };
const PERMISSION_LABEL: Record<Permission, string> = { downloads: 'загрузки', print: 'печать' };

function usage(dataDir: string): string {
  return [
    'Управление пользователями семейного портала.',
    '',
    'Команды (из папки проекта):',
    '  scripts\\user.cmd add <логин> --name "<Имя>" --role family|admin [--generate-password]',
    '  scripts\\user.cmd list',
    '  scripts\\user.cmd passwd <логин> [--generate-password]',
    '  scripts\\user.cmd role <логин> family|admin',
    '  scripts\\user.cmd allow <логин> downloads|print   (дать право: загрузки / печать)',
    '  scripts\\user.cmd deny <логин> downloads|print    (забрать право)',
    '  scripts\\user.cmd remove <логин> --yes',
    '',
    'Логин: латиница в нижнем регистре, цифры, «.», «_», «-» (2–32 символа), например mama.',
    'Пароль вводится дважды и не отображается на экране; не меньше 10 символов.',
    'Для скриптов: --password-stdin — прочитать пароль одной строкой из стандартного ввода.',
    '--generate-password — создать случайный временный пароль: он показывается один раз, действует',
    '  7 дней и только для первого входа — сразу после входа портал попросит придумать свой.',
    `Каталог данных: ${dataDir} (переменная DASHBOARD_DATA_DIR).`,
  ].join('\n');
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['name', 'role']);
const BOOLEAN_FLAGS = new Set(['yes', 'password-stdin', 'generate-password', 'help']);

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
        if (value === undefined) throw new CliError(`Для --${name} нужно значение.`, 2);
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

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function parseRole(value: string | undefined, fallback?: Role): Role {
  const role = (value ?? fallback ?? '').trim().toLowerCase();
  if (role !== 'family' && role !== 'admin') throw new CliError('Роль должна быть family или admin.', 2);
  return role;
}

/** Reads one line from a piped stdin (for --password-stdin). */
function readLineFromStdin(): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('end', finish);
      stdin.off('error', onError);
      stdin.pause();
    };
    function finish() {
      if (settled) return;
      settled = true;
      cleanup();
      const text = stripBom(Buffer.concat(chunks).toString('utf8'));
      const newline = text.indexOf('\n');
      resolve((newline === -1 ? text : text.slice(0, newline)).replace(/\r$/, ''));
    }
    function onData(chunk: Buffer | string) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      chunks.push(buffer);
      if (buffer.includes(0x0a)) finish();
    }
    function onError(error: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    stdin.on('data', onData);
    stdin.on('end', finish);
    stdin.on('error', onError);
    stdin.resume();
  });
}

/** Hidden input on a TTY: raw mode, no echo; handles Backspace, Enter, Ctrl+C. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = stdin.isRaw;
    const finish = (error?: CliError) => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    function onData(chunk: Buffer | string) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.startsWith('\u001b')) return; // arrow keys and other escape sequences
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new CliError('Отменено.', 130));
        if (ch === '\u0004') {
          if (value === '') return finish(new CliError('Отменено.', 130));
          continue;
        }
        if (ch === '\b' || ch === '\u007f') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
      }
    }
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.resume();
  });
}

interface ObtainedPassword {
  password: string;
  /** Generated: shown once, must be replaced at the first sign-in, expires at this time. */
  temporaryUntil?: string;
}

function printTemporaryPassword(username: string, password: string, until: string): void {
  const date = new Date(until).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  console.log('');
  console.log(`  Логин:            ${username}`);
  console.log(`  Временный пароль: ${password}`);
  console.log('');
  console.log(`Пароль показан один раз и нигде не сохранён. Он действует до ${date} и только для`);
  console.log('первого входа: сразу после входа портал попросит придумать свой пароль.');
}

async function obtainPassword(username: string, args: ParsedArgs): Promise<ObtainedPassword> {
  if (args.flags.has('generate-password')) {
    if (args.flags.has('password-stdin')) {
      throw new CliError('Укажите что-то одно: --generate-password или --password-stdin.', 2);
    }
    return {
      password: generatePassword(),
      temporaryUntil: new Date(Date.now() + TEMPORARY_PASSWORD_TTL_MS).toISOString(),
    };
  }
  return { password: await obtainOwnPassword(username, args) };
}

async function obtainOwnPassword(username: string, args: ParsedArgs): Promise<string> {
  if (args.flags.has('password-stdin')) {
    const password = await readLineFromStdin();
    const problem = checkPasswordPolicy(password, username);
    if (problem) throw new CliError(problem);
    return password;
  }
  if (!process.stdin.isTTY) {
    throw new CliError(
      'Пароль можно ввести только в окне терминала (без отображения на экране). Для скриптов используйте --password-stdin.',
      2,
    );
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const password = await promptHidden('Пароль (не отображается): ');
    const problem = checkPasswordPolicy(password, username);
    if (problem) {
      console.error(problem);
      continue;
    }
    const repeat = await promptHidden('Повторите пароль: ');
    if (repeat !== password) {
      console.error('Пароли не совпадают, попробуйте ещё раз.');
      continue;
    }
    return password;
  }
  throw new CliError('Пароль не задан: три неудачные попытки.');
}

async function requireUser(store: UserStore, rawName: string | undefined): Promise<StoredUser> {
  if (!rawName) throw new CliError('Укажите логин пользователя.', 2);
  const user = await store.findByUsername(rawName);
  if (!user) throw new CliError(`Пользователь «${normaliseUsername(rawName)}» не найден.`);
  return user;
}

function adminCount(users: readonly StoredUser[]): number {
  return users.filter((user) => user.role === 'admin').length;
}

function passwordState(user: StoredUser): string {
  if (!needsPasswordChange(user)) return 'свой';
  if (temporaryPasswordExpired(user, Date.now())) return 'временный, срок истёк';
  return `временный, до ${(user.passwordExpiresAt ?? '').slice(0, 10)}`;
}

function describeUser(user: Pick<StoredUser, 'username' | 'displayName' | 'role'>): string {
  return `«${user.username}» (${user.displayName}, роль: ${ROLE_LABEL[user.role]})`;
}

async function run(argv: string[]): Promise<void> {
  const config = loadConfig(process.env);
  const args = parseArgs(argv);
  const [command, target] = args.positional;
  if (!command || args.flags.has('help') || command === 'help') {
    console.log(usage(config.dataDir));
    if (!command && !args.flags.has('help')) throw new CliError('Не указана команда.', 2);
    return;
  }

  await fsp.mkdir(config.dataDir, { recursive: true });
  const store = createUserStore(config.dataDir, { clock: systemClock, reloadIntervalMs: 0 });
  const users = await store.reload();

  switch (command) {
    case 'add': {
      if (!target) throw new CliError('Укажите логин: add <логин> --name "<Имя>" --role family|admin', 2);
      const username = normaliseUsername(target);
      if (!USERNAME_RE.test(username)) {
        throw new CliError('Недопустимый логин: латиница, цифры, «.», «_», «-», от 2 до 32 символов.', 2);
      }
      if (users.some((user) => user.username === username)) {
        throw new CliError(`Пользователь «${username}» уже существует.`);
      }
      const displayName = (stringFlag(args, 'name') ?? username).trim();
      if (displayName === '' || displayName.length > DISPLAY_NAME_MAX) {
        throw new CliError(`Имя для приветствия должно быть от 1 до ${DISPLAY_NAME_MAX} символов.`, 2);
      }
      const role = parseRole(stringFlag(args, 'role'), 'family');
      const { password, temporaryUntil } = await obtainPassword(username, args);
      const user = await store.add({
        username,
        displayName,
        role,
        passwordHash: await hashPassword(password),
        ...(temporaryUntil ? { temporaryUntil } : {}),
      });
      console.log(`Пользователь ${describeUser(user)} создан. Теперь он может войти в портал.`);
      if (temporaryUntil) printTemporaryPassword(user.username, password, temporaryUntil);
      return;
    }
    case 'list': {
      if (users.length === 0) {
        console.log(`Пользователей пока нет. Каталог данных: ${config.dataDir}`);
        return;
      }
      // Sign-in times are kept by the server in logins.json (older versions: inside users.json).
      const times = await readLoginTimes(config.dataDir).catch((error: unknown) => {
        console.error(`Время последнего входа недоступно: ${(error as Error).message}`);
        return {} as Record<string, string>;
      });
      const rows = users.map((user) => {
        const lastLoginAt = lastLoginOf(user, { get: (id) => times[id] ?? null });
        return [
          user.username,
          user.displayName,
          ROLE_LABEL[user.role],
          user.createdAt.slice(0, 10),
          lastLoginAt ? lastLoginAt.replace('T', ' ').slice(0, 16) : 'не входил',
          passwordState(user),
          user.role === 'admin'
            ? 'все'
            : (user.permissions ?? []).map((p) => PERMISSION_LABEL[p]).join(', ') || '—',
        ];
      });
      const header = ['Логин', 'Имя', 'Роль', 'Создан', 'Последний вход', 'Пароль', 'Права'];
      const widths = header.map((title, col) =>
        Math.max(title.length, ...rows.map((row) => (row[col] ?? '').length)),
      );
      const line = (cells: string[]) => cells.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join('  ');
      console.log(line(header));
      for (const row of rows) console.log(line(row));
      return;
    }
    case 'passwd': {
      const user = await requireUser(store, target);
      const { password, temporaryUntil } = await obtainPassword(user.username, args);
      await store.update(user.id, {
        passwordHash: await hashPassword(password),
        passwordChangedAt: new Date().toISOString(),
        mustChangePassword: temporaryUntil !== undefined,
        passwordExpiresAt: temporaryUntil ?? null,
      });
      console.log(`Пароль пользователя «${user.username}» изменён. Все его открытые сеансы завершены.`);
      if (temporaryUntil) printTemporaryPassword(user.username, password, temporaryUntil);
      return;
    }
    case 'role': {
      const user = await requireUser(store, target);
      const role = parseRole(args.positional[2]);
      if (user.role === role) {
        console.log(`У пользователя «${user.username}» уже роль «${ROLE_LABEL[role]}».`);
        return;
      }
      if (user.role === 'admin' && adminCount(users) <= 1) {
        throw new CliError('Нельзя снять роль с последнего администратора: сначала назначьте другого.');
      }
      await store.update(user.id, { role });
      console.log(`Роль пользователя «${user.username}» изменена на «${ROLE_LABEL[role]}».`);
      return;
    }
    case 'allow':
    case 'deny': {
      const user = await requireUser(store, target);
      const right = (args.positional[2] ?? '').trim().toLowerCase();
      if (!PERMISSIONS.includes(right as Permission)) {
        throw new CliError(`Право должно быть одним из: ${PERMISSIONS.join(', ')}.`, 2);
      }
      const permission = right as Permission;
      const current = new Set(user.permissions ?? []);
      if (command === 'allow') current.add(permission);
      else current.delete(permission);
      await store.update(user.id, { permissions: PERMISSIONS.filter((p) => current.has(p)) });
      const label = PERMISSION_LABEL[permission];
      if (user.role === 'admin') {
        console.log(`«${user.username}» — администратор: у него и так есть все права (${label}).`);
      } else {
        console.log(
          command === 'allow'
            ? `Пользователю «${user.username}» разрешено: ${label}.`
            : `У пользователя «${user.username}» больше нет права: ${label}.`,
        );
      }
      return;
    }
    case 'remove': {
      const user = await requireUser(store, target);
      if (!args.flags.has('yes')) {
        throw new CliError(`Чтобы удалить ${describeUser(user)}, повторите команду с --yes.`, 2);
      }
      if (user.role === 'admin' && adminCount(users) <= 1) {
        throw new CliError('Нельзя удалить последнего администратора: сначала назначьте другого.');
      }
      await store.remove(user.id);
      console.log(`Пользователь «${user.username}» удалён. Его сеансы больше не действуют.`);
      return;
    }
    default:
      throw new CliError(`Неизвестная команда «${command}». Справка: scripts\\user.cmd --help`, 2);
  }
}

run(process.argv.slice(2)).then(
  () => {
    process.exitCode = 0;
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
