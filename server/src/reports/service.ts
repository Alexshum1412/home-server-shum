import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MetricsPoint, SystemResponse } from '../../../shared/api.ts';
import type { DiskForecast, Incident } from '../../../shared/extras.ts';
import type { StoredUser } from '../auth/users.ts';
import { newId } from '../lib/ids.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';
import { type ReportPage, serverReport, weekReport } from './build.ts';
import type { Renderer } from './render.ts';

export type ReportKind = 'server' | 'week';

export interface MadeReport {
  id: string;
  kind: ReportKind;
  title: string;
  summary: string;
  png: string;
  pdf: string;
}

interface Meta {
  id: string;
  owner: string;
  kind: ReportKind;
  title: string;
  summary: string;
  at: string;
}

const KEEP_DAYS = 30;

/** Reports on request: made from the live numbers, kept for a month in the person's name, shown as a picture and a document. */
export function createReports(options: {
  dataDir: string;
  clock: Clock;
  renderer: Renderer;
  system: (admin: boolean) => SystemResponse;
  history: () => MetricsPoint[];
  extras: () => Promise<{ forecast: DiskForecast[]; incidents: Incident[]; internetUp: boolean | null }>;
  downloads: () => { active: number; done24h: number };
  week: (
    user: StoredUser,
  ) => Promise<{ tasks: string[]; events: string[]; deadlines: string[]; downloads: string[] }>;
}) {
  const dir = path.join(options.dataDir, 'reports');
  const queue = createSerialQueue();

  async function sweep(): Promise<void> {
    const limit = options.clock().getTime() - KEEP_DAYS * 86_400_000;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const info = await stat(path.join(dir, name)).catch(() => null);
      if (info && info.mtimeMs < limit) await rm(path.join(dir, name), { force: true });
    }
  }

  async function build(user: StoredUser, kind: ReportKind): Promise<ReportPage | null> {
    const now = options.clock();
    if (kind === 'server') {
      const extra = await options.extras();
      return serverReport({
        now,
        system: options.system(user.role === 'admin'),
        history: options.history(),
        forecast: extra.forecast,
        incidents: extra.incidents,
        downloads: options.downloads(),
        internetUp: extra.internetUp,
      });
    }
    return weekReport({ now, name: user.displayName, ...(await options.week(user)) });
  }

  return {
    available: () => options.renderer.available(),
    async make(user: StoredUser, kind: ReportKind): Promise<MadeReport | null> {
      if (kind === 'server' && user.role !== 'admin') return null;
      const page = await build(user, kind);
      if (!page) return null;
      const out = await options.renderer.render(page.html, page.width, page.height);
      if (!out) return null;
      return queue.run(async () => {
        await mkdir(dir, { recursive: true });
        const id = newId();
        await writeFile(path.join(dir, `${id}.png`), out.png);
        await writeFile(path.join(dir, `${id}.pdf`), out.pdf);
        const meta: Meta = {
          id,
          owner: user.username,
          kind,
          title: page.title,
          summary: page.summary,
          at: options.clock().toISOString(),
        };
        await writeJsonAtomic(path.join(dir, `${id}.json`), meta);
        void sweep();
        return {
          id,
          kind,
          title: page.title,
          summary: page.summary,
          png: `/api/reports/${id}/png`,
          pdf: `/api/reports/${id}/pdf`,
        };
      });
    },
    /** The file of a report for its owner (or an administrator), or null. */
    async file(user: StoredUser, id: string, ext: 'png' | 'pdf'): Promise<string | null> {
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
      const meta = (await readJsonFile(path.join(dir, `${id}.json`)).catch(() => undefined)) as
        | Meta
        | undefined;
      if (!meta || (meta.owner !== user.username && user.role !== 'admin')) return null;
      const file = path.join(dir, `${id}.${ext}`);
      return (await stat(file).catch(() => null)) ? file : null;
    },
  };
}

export type Reports = ReturnType<typeof createReports>;

/** What in a message asks for a report: «отчёт о сервере», «фото-отчёт», «сводка недели документом». */
export function reportIntent(message: string): ReportKind | null {
  const text = message.toLowerCase().replace(/ё/g, 'е');
  const wants =
    /(отчет|отчёт|документ|pdf|пдф|в виде картинк|в виде фото|фотоотчет|фото-отчет|с графиками|с метриками)/.test(
      text,
    );
  if (!wants) return null;
  if (/(сервер|состояни|компьютер|диск|нагрузк|метрик|здоровь)/.test(text)) return 'server';
  if (/(недел|дела|календар|план|сводк)/.test(text)) return 'week';
  return null;
}
