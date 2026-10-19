/**
 * Makes a diagnostic report safe to copy into a message to a helper: passwords, tokens, keys and
 * session ids, e-mail addresses, the family's folders, names of people, addresses of devices and of
 * the home network, the names of this computer and of the tailnet, and the texts of messages are
 * replaced by a marker. The function is pure and says what it removed (kind and number), so the page
 * can tell the person. It errs on the side of removing too much.
 */

export interface SanitizeContext {
  /** Logins and display names of the family: replaced wherever they appear as whole words. */
  names?: readonly string[];
  /** Names of this computer and addresses of the portal (host names): replaced as they are. */
  hosts?: readonly string[];
}

export interface SanitizeResult {
  text: string;
  removed: Array<{ what: string; count: number }>;
}

export const KIND = {
  secrets: 'пароли, ключи и токены',
  mail: 'адреса электронной почты',
  paths: 'папки и пути семьи',
  network: 'адреса устройств и сети',
  hosts: 'имена компьютера и сети',
  names: 'имена людей',
  texts: 'тексты сообщений',
} as const;

const SEP = '[\\\\/]+';
const PATH_CHAR = '[^\\s"\'<>|]';

const SECRET_WORDS =
  'password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|set-cookie|session[_-]?id|sessionid|session|sid|credentials?|private[_-]?key|recovery[_-]?code|key[_-]?file|парол[а-яё]*|токен[а-яё]*|ключ[а-яё]*|секрет[а-яё]*|куки';
// «user_password», «x-api-key», «sessionToken»: the secret word with other words around it.
const SECRET_KEY = `(?:[\\p{L}\\p{N}]+[_.-])*(?:${SECRET_WORDS})(?:[_.-][\\p{L}\\p{N}]+)*`;

const SECRET_PAIR = new RegExp(
  `(["']?)(?<![\\p{L}\\p{N}_])(${SECRET_KEY})(?![\\p{L}\\p{N}_])\\1(\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|Bearer\\s+\\S+|[^\\s,;&}\\])"']+)`,
  'giu',
);
// Header lines carry the whole rest of the line: «cookie: a=1; b=2».
const HEADER_LINE =
  /\b(cookie|set-cookie|authorization)(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\r\n]+)/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const OPAQUE = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const FAMILY_DATA = new RegExp(`[A-Za-z]:${SEP}FamilyData(?:${SEP}${PATH_CHAR}*)?`, 'gi');
const WINDOWS_USER = new RegExp(`([A-Za-z]:${SEP}Users${SEP})[^\\\\/\\s"'<>|]+`, 'gi');
const USERS_FOLDER = new RegExp(`(\\busers${SEP})[^\\\\/\\s"'<>|]+`, 'gi');
const TAILNET = /\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:.])/gi;
const TEXT_FIELD = /("(?:text|body|note|comment|content|caption|messageText)"\s*:\s*)"(?:[^"\\]|\\.)*"/g;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The marker keeps the quote style of a JSON value, so a sanitised JSON file stays valid JSON. */
const hidden = (value: string) =>
  value.startsWith('"') ? '"[скрыто]"' : value.startsWith("'") ? "'[скрыто]'" : '[скрыто]';

export function sanitizeReport(input: string, context: SanitizeContext = {}): SanitizeResult {
  const counts = new Map<string, number>();
  const bump = (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1);
  let text = input;

  // 1. Secrets first: a token inside an address must go before anything cuts the address up.
  text = text.replace(HEADER_LINE, (_m, key: string, glue: string, value: string) => {
    bump(KIND.secrets);
    return `${key}${glue}${hidden(value)}`;
  });
  text = text.replace(SECRET_PAIR, (match, quote: string, key: string, glue: string, value: string) => {
    // «tokens: 3» is a count, not a token; a value that is already a marker is not hidden twice.
    if (value.startsWith('[') || /^\d{1,6}$/.test(value) || /^(true|false|null|none|yes|no)$/i.test(value))
      return match;
    bump(KIND.secrets);
    return `${quote}${key}${quote}${glue}${hidden(value)}`;
  });
  text = text.replace(JWT, () => {
    bump(KIND.secrets);
    return '[ключ]';
  });
  text = text.replace(BEARER, () => {
    bump(KIND.secrets);
    return 'Bearer [скрыто]';
  });

  // 2. Texts of messages and notes.
  text = text.replace(TEXT_FIELD, (_m, head: string) => {
    bump(KIND.texts);
    return `${head}"[скрыто]"`;
  });

  // 3. Folders of the family.
  text = text.replace(FAMILY_DATA, () => {
    bump(KIND.paths);
    return '[папка семьи]';
  });
  text = text.replace(WINDOWS_USER, (_m, head: string) => {
    bump(KIND.paths);
    return `${head}[имя]`;
  });
  text = text.replace(USERS_FOLDER, (_m, head: string) => {
    bump(KIND.paths);
    return `${head}[имя]`;
  });

  // 4. Mail.
  text = text.replace(EMAIL, () => {
    bump(KIND.mail);
    return '[почта]';
  });

  // 5. The names of the network and of this computer (the whole tailnet address first, so that it goes as one piece).
  text = text.replace(TAILNET, () => {
    bump(KIND.hosts);
    return '[адрес в сети семьи]';
  });
  for (const host of [...(context.hosts ?? [])]
    .filter((value) => value.length >= 3)
    .sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(escapeRegExp(host), 'gi'), () => {
      bump(KIND.hosts);
      return '[имя компьютера]';
    });
  }

  // 6. Addresses: the portal's own loopback stays, everything else is somebody's device.
  text = text.replace(IPV4, (match) => {
    const parts = match.split('.').map(Number);
    if (parts.some((part) => part > 255)) return match; // a version such as 10.0.19045.6456
    if (match === '127.0.0.1' || match === '0.0.0.0') return match;
    bump(KIND.network);
    return '[адрес]';
  });
  text = text.replace(IPV6, (match) => {
    // A time such as 10:25:33 is not an address.
    if (!(/[a-f]/i.test(match) || match.includes('::') || match.split(':').length >= 6)) return match;
    if (match === '::1') return match;
    bump(KIND.network);
    return '[адрес]';
  });

  // 7. Long opaque strings (keys, hashes, session ids) that no pattern above recognised.
  text = text.replace(OPAQUE, (match) => {
    if (!(/\d/.test(match) && /[A-Za-z]/.test(match))) return match;
    bump(KIND.secrets);
    return '[ключ]';
  });

  // 8. The names of the family.
  const names = [
    ...new Set((context.names ?? []).map((name) => name.trim()).filter((name) => name.length >= 3)),
  ].sort((a, b) => b.length - a.length);
  for (const name of names) {
    text = text.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'giu'),
      () => {
        bump(KIND.names);
        return '[человек]';
      },
    );
  }

  return {
    text,
    removed: [...counts.entries()].map(([what, count]) => ({ what, count })),
  };
}
