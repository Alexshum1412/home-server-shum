import path from 'node:path';
import { z } from 'zod';
import type { ServiceKind } from '../../../shared/api.ts';
import { readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';

export interface ServiceDefinition {
  id: string;
  kind: ServiceKind;
  name: string;
  description: string;
  openUrl: string | null;
  healthUrl: string | null;
  enabled: boolean;
  hint: string | null;
}

export interface ServicesFile {
  version: 1;
  services: ServiceDefinition[];
}

const SERVICE_KINDS = ['media', 'photos', 'files', 'downloads', 'print', 'calendar', 'other'] as const;

const serviceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'id: латиница, цифры, «-» или «_», до 32 символов'),
  kind: z.enum(SERVICE_KINDS),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(200),
  // URLs are validated by the checker so that one bad address only affects its own service.
  openUrl: z.string().max(2048).nullable(),
  healthUrl: z.string().max(2048).nullable(),
  enabled: z.boolean(),
  hint: z.string().max(500).nullable(),
});

const fileSchema = z
  .object({ version: z.literal(1), services: z.array(serviceSchema).max(50) })
  .refine((file) => new Set(file.services.map((s) => s.id)).size === file.services.length, {
    message: 'id сервисов должны быть уникальными',
  });

export const DEFAULT_SERVICES: readonly ServiceDefinition[] = Object.freeze([
  {
    id: 'media',
    kind: 'media',
    name: 'Кинотеатр',
    description: 'Фильмы и сериалы (Jellyfin)',
    openUrl: null,
    healthUrl: null,
    enabled: true,
    hint: 'Кинотеатр пока не подключён. Попросите администратора установить Jellyfin.',
  },
  {
    id: 'photos',
    kind: 'photos',
    name: 'Фотографии',
    description: 'Семейные фото и видео (Immich)',
    openUrl: null,
    healthUrl: null,
    enabled: true,
    hint: 'Фотоальбом пока не подключён. Попросите администратора установить Immich.',
  },
  {
    id: 'files',
    kind: 'files',
    name: 'Файлы',
    description: 'Личные и общие папки',
    openUrl: null,
    healthUrl: null,
    enabled: true,
    hint: 'Общие папки пока не подключены. Попросите администратора настроить файловый сервис.',
  },
  {
    id: 'downloads',
    kind: 'downloads',
    name: 'Загрузки',
    description: 'Загрузка фильмов и файлов',
    openUrl: null,
    healthUrl: null,
    enabled: true,
    hint: 'Загрузки пока не подключены. Попросите администратора установить программу для загрузок.',
  },
  {
    id: 'calendar',
    kind: 'calendar',
    name: 'Календарь',
    description: 'Семейный календарь и заметки',
    openUrl: null,
    healthUrl: null,
    enabled: true,
    hint: 'Семейный календарь появится в одной из следующих версий портала.',
  },
]);

export interface LoadedServices {
  services: ServiceDefinition[];
  /** Russian description of why services.json could not be used; null when it is fine. */
  configError: string | null;
}

export function servicesFilePath(dataDir: string): string {
  return path.join(dataDir, 'services.json');
}

/**
 * Loads services.json. A missing file is created from the defaults; an invalid file is
 * never overwritten — the list is empty and `configError` explains the problem.
 */
export async function loadServicesConfig(dataDir: string): Promise<LoadedServices> {
  const file = servicesFilePath(dataDir);
  let data: unknown;
  try {
    data = await readJsonFile(file);
  } catch (error) {
    return { services: [], configError: `Файл services.json не читается: ${(error as Error).message}` };
  }
  if (data === undefined) {
    const services = DEFAULT_SERVICES.map((service) => ({ ...service }));
    await writeJsonAtomic(file, { version: 1, services } satisfies ServicesFile);
    return { services, configError: null };
  }
  const parsed = fileSchema.safeParse(data);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`)
      .join('; ');
    return { services: [], configError: `Файл services.json содержит ошибку — ${details}` };
  }
  return { services: parsed.data.services, configError: null };
}

/** Only absolute http(s) URLs without embedded credentials are accepted. */
export function safeHttpUrl(value: string | null): { ok: true; url: string | null } | { ok: false } {
  if (value === null || value.trim() === '') return { ok: true, url: null };
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return { ok: false };
    }
    return { ok: true, url: url.href };
  } catch {
    return { ok: false };
  }
}
