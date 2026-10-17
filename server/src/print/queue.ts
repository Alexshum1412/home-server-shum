/**
 * Print queue (P7): a family member uploads a PDF or JPEG, the printer validates the job
 * (Validate-Job, nothing is printed), the user confirms, the file goes to the printer
 * (Print-Job) and its state is followed until it is done. The server never opens, renders or
 * runs the document: it only forwards the bytes to the printer.
 *
 * When the printer is switched off the document is kept («held») and the user may choose to put it
 * in the waiting queue («queued»): it is sent by itself when the printer answers again, within a
 * day. Nothing waits in the queue without that explicit choice.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  PrintColorMode,
  PrinterIppStatus,
  PrintJobState,
  PrintJobView,
  PrintSides,
} from '../../../shared/api.ts';
import { sanitizeName } from '../files/names.ts';
import { readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import {
  attr,
  decodeResponse,
  encodeRequest,
  httpTransport,
  IppError,
  type IppTransport,
  JOB_STATE,
  OP,
  PRINTER_STATE,
  printerUriOf,
  statusMessage,
} from './ipp.ts';

export class PrintError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface PrintOptions {
  copies: number;
  sides: PrintSides;
  colorMode: PrintColorMode;
}

interface StoredJob extends PrintJobView {
  printerJobId: number | null;
}

export interface PrintQueueOptions {
  dataDir: string;
  /** null — printing is not configured. */
  printerUrl: string | null;
  maxBytes: number;
  clock: Clock;
  transport?: IppTransport;
  /** How often a sent job is polled (ms). */
  pollMs?: number;
  /** How often waiting jobs look for the printer (ms), 30 s by default. */
  deferredPollMs?: number;
  /** Tests: the first status request waits for the printer instead of answering «checking». */
  waitForFirstProbe?: boolean;
  onEvent?: (event: {
    action: 'print.submit' | 'print.cancel' | 'print.fail';
    actor: string;
    detail: string;
  }) => void;
}

const CHECKED_TTL_MS = 60 * 60_000;
/** A document kept because the printer was off, until the user decides. */
const HELD_TTL_MS = 6 * 60 * 60_000;
/** A document the user queued for later; after this it is dropped, not printed at a surprising time. */
const QUEUED_TTL_MS = 24 * 60 * 60_000;
const FINAL: ReadonlySet<PrintJobState> = new Set(['completed', 'canceled', 'failed', 'expired']);
const TIMEOUT_MS = 20_000;

/** Only PDF and JPEG, recognised by their first bytes (the name does not matter). */
export function sniffPrintable(head: Buffer): 'pdf' | 'jpeg' | null {
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  return null;
}

const MIME = { pdf: 'application/pdf', jpeg: 'image/jpeg' } as const;

export function createPrintQueue(options: PrintQueueOptions) {
  const file = path.join(options.dataDir, 'print-jobs.json');
  const spool = path.join(options.dataDir, 'print-spool');
  const transport = options.transport ?? httpTransport;
  const pollMs = options.pollMs ?? 5000;
  const deferredPollMs = options.deferredPollMs ?? 30_000;
  let deferredTimer: NodeJS.Timeout | null = null;
  let deferredRunning = false;
  let jobs: StoredJob[] = [];
  let requestId = 1;
  const polling = new Map<string, NodeJS.Timeout>();
  let printerCache: { at: number; value: PrinterIppStatus } | null = null;
  let refreshPrinter: Promise<PrinterIppStatus> | null = null;

  const now = () => options.clock().getTime();
  const spoolFile = (id: string) => path.join(spool, `${id}.bin`);

  let saving: Promise<void> = Promise.resolve();
  let stopped = false;
  /** Writes are serialised: a poll timer and a request must not race on the same file. */
  function save(): Promise<void> {
    const snapshot = jobs.map((j) => ({ ...j }));
    saving = saving.then(() => writeJsonAtomic(file, { version: 1, jobs: snapshot })).catch(() => undefined);
    return saving;
  }

  function view(job: StoredJob): PrintJobView {
    const { printerJobId: _p, ...rest } = job;
    return rest;
  }

  async function call(
    operation: number,
    opAttrs: Parameters<typeof encodeRequest>[3],
    jobAttrs: Parameters<typeof encodeRequest>[4] = [],
    document?: Buffer,
  ) {
    if (!options.printerUrl)
      throw new PrintError(503, 'not_configured', 'Печать не настроена на сервере (PRINTER_IPP_URL).');
    const head = encodeRequest(operation, requestId++, printerUriOf(options.printerUrl), opAttrs, jobAttrs);
    const body = document ? Buffer.concat([head, document]) : head;
    try {
      return decodeResponse(
        await transport(options.printerUrl, body, document ? 120_000 : TIMEOUT_MS, document !== undefined),
      );
    } catch (error) {
      if (error instanceof IppError) throw new PrintError(502, 'printer_unreachable', error.message);
      throw error;
    }
  }

  function jobAttributes(o: PrintOptions) {
    return [
      attr.integer('copies', o.copies),
      attr.keyword('sides', o.sides),
      attr.keyword('print-color-mode', o.colorMode),
    ];
  }

  function update(job: StoredJob, patch: Partial<StoredJob>): void {
    Object.assign(job, patch, { updatedAt: isoNow(options.clock) });
  }

  async function finish(job: StoredJob, state: PrintJobState, message: string): Promise<void> {
    const timer = polling.get(job.id);
    if (timer) clearTimeout(timer);
    polling.delete(job.id);
    // The document is gone before the job reads as finished.
    await fsp.rm(spoolFile(job.id), { force: true }).catch(() => undefined);
    update(job, { state, message });
    await save();
  }

  function schedulePoll(job: StoredJob): void {
    if (stopped) return;
    const timer = setTimeout(() => void poll(job), pollMs);
    timer.unref?.();
    polling.set(job.id, timer);
  }

  async function poll(job: StoredJob): Promise<void> {
    polling.delete(job.id);
    if (FINAL.has(job.state) || job.printerJobId === null) return;
    try {
      const res = await call(OP.getJobAttributes, [
        attr.integer('job-id', job.printerJobId),
        attr.keyword('requested-attributes', 'job-state', 'job-state-reasons'),
      ]);
      const state = JOB_STATE[Number(res.attrs.get('job-state')?.[0])];
      if (state === 'completed') return finish(job, 'completed', 'Напечатано');
      if (state === 'canceled') return finish(job, 'canceled', 'Задание отменено на принтере');
      if (state === 'aborted') {
        options.onEvent?.({ action: 'print.fail', actor: job.owner, detail: 'принтер прервал задание' });
        return finish(job, 'failed', 'Принтер прервал печать (замятие, нет бумаги или ошибка файла)');
      }
      update(job, {
        state: state === 'processing' ? 'printing' : 'sent',
        message:
          state === 'processing'
            ? 'Печатается'
            : state === 'stopped'
              ? 'Принтер остановлен — проверьте бумагу и картриджи'
              : 'В очереди принтера',
      });
      await save();
    } catch {
      // the printer may be busy or asleep: try again later, the state stays as it was
    }
    if (now() - Date.parse(job.createdAt) < 6 * 60 * 60_000) schedulePoll(job);
  }

  /** How long a job in this state may wait; null — it does not expire by itself. */
  function ttlOf(job: StoredJob): number | null {
    if (job.state === 'checked') return CHECKED_TTL_MS;
    if (job.state === 'held') return HELD_TTL_MS;
    if (job.state === 'queued') return QUEUED_TTL_MS;
    return null;
  }

  function expireOld(): void {
    const t = now();
    for (const job of jobs) {
      const ttl = ttlOf(job);
      if (ttl !== null && t - Date.parse(job.createdAt) > ttl) {
        const message =
          job.state === 'queued'
            ? 'Принтер так и не появился за сутки — документ удалён с сервера'
            : 'Не подтверждено вовремя — загрузите файл ещё раз';
        // Marked at once (the list answers with it); the document is removed right behind.
        update(job, { state: 'expired', message });
        void finish(job, 'expired', message);
      }
    }
  }

  /** Sends the stored document to the printer and starts following the job. */
  async function dispatch(job: StoredJob, actor: string, viaQueue: boolean): Promise<void> {
    const document = await fsp.readFile(spoolFile(job.id));
    const res = await call(
      OP.printJob,
      [
        attr.name('requesting-user-name', job.owner),
        attr.name('job-name', job.fileName),
        attr.mime('document-format', MIME[job.format]),
      ],
      jobAttributes(job),
      document,
    );
    if (res.status >= 0x0100) {
      await finish(job, 'failed', statusMessage(res.status));
      options.onEvent?.({ action: 'print.fail', actor, detail: statusMessage(res.status) });
      throw new PrintError(422, 'rejected', statusMessage(res.status));
    }
    const printerJobId = Number(res.attrs.get('job-id')?.[0]);
    update(job, {
      state: 'sent',
      message: viaQueue ? 'Принтер появился: отправлено из очереди' : 'Отправлено на принтер',
      printerJobId: Number.isFinite(printerJobId) ? printerJobId : null,
    });
    await save();
    options.onEvent?.({
      action: 'print.submit',
      actor,
      detail: `${job.format.toUpperCase()}, ${Math.max(1, Math.round(job.sizeBytes / 1024))} КБ, копий: ${job.copies}${
        viaQueue ? ' (из очереди ожидания)' : ''
      }`,
    });
    if (job.printerJobId !== null) schedulePoll(job);
  }

  /** Looks at the waiting jobs: the printer answers again → they go out, oldest first. */
  async function runDeferred(): Promise<void> {
    if (deferredRunning || stopped) return;
    expireOld();
    const waiting = jobs.filter((j) => j.state === 'queued');
    if (waiting.length === 0) {
      if (deferredTimer) clearInterval(deferredTimer);
      deferredTimer = null;
      return;
    }
    deferredRunning = true;
    try {
      const status = await probePrinter();
      if (status.reachable !== true || status.acceptingJobs === false || status.state === 'stopped') return;
      for (const job of waiting) {
        if (stopped || job.state !== 'queued') continue;
        try {
          await dispatch(job, job.owner, true);
        } catch (error) {
          if (error instanceof PrintError && error.code === 'printer_unreachable') return; // asleep again
          if (!(error instanceof PrintError)) throw error;
        }
      }
    } catch {
      // the printer is still away: try again at the next tick
    } finally {
      deferredRunning = false;
    }
  }

  function ensureDeferredTimer(): void {
    if (deferredTimer || stopped) return;
    deferredTimer = setInterval(() => void runDeferred(), deferredPollMs);
    deferredTimer.unref?.();
  }

  return {
    configured: () => options.printerUrl !== null,

    async load(): Promise<void> {
      const data = (await readJsonFile(file).catch(() => undefined)) as { jobs?: StoredJob[] } | undefined;
      jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      for (const job of jobs) {
        if (job.state === 'sent' || job.state === 'printing') schedulePoll(job);
      }
      if (jobs.some((job) => job.state === 'queued')) ensureDeferredTimer();
    },

    list(owner: string | null): PrintJobView[] {
      expireOld();
      return jobs
        .filter((j) => owner === null || j.owner === owner)
        .map(view)
        .reverse()
        .slice(0, 50);
    },

    /** Spools the upload, checks the content and lets the printer validate the job. */
    async prepare(
      owner: string,
      rawName: string,
      declaredBytes: number,
      body: NodeJS.ReadableStream,
      o: PrintOptions,
    ): Promise<PrintJobView> {
      if (!options.printerUrl) throw new PrintError(503, 'not_configured', 'Печать не настроена на сервере.');
      const name = sanitizeName(rawName) ?? 'документ';
      if (!Number.isFinite(declaredBytes) || declaredBytes <= 0)
        throw new PrintError(411, 'length_required', 'Неизвестен размер файла.');
      if (declaredBytes > options.maxBytes) {
        throw new PrintError(
          413,
          'too_large',
          `Файл слишком большой для печати: не больше ${Math.round(options.maxBytes / 1024 ** 2)} МБ.`,
        );
      }
      await fsp.mkdir(spool, { recursive: true });
      const id = randomUUID();
      const target = spoolFile(id);
      let received = 0;
      let head = Buffer.alloc(0);
      let format: 'pdf' | 'jpeg' | null = null;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, callback) {
          received += chunk.length;
          if (received > declaredBytes)
            return callback(new PrintError(413, 'too_large', 'Файл больше заявленного размера.'));
          if (format === null) {
            head = Buffer.concat([head, chunk]).subarray(0, 8);
            if (head.length >= 5 || received >= declaredBytes) {
              format = sniffPrintable(head);
              if (!format) {
                return callback(
                  new PrintError(
                    415,
                    'unsupported_format',
                    'Печатаются только PDF и JPG. Документ Word или Excel сохраните как PDF («Файл» → «Сохранить как» → PDF).',
                  ),
                );
              }
            }
          }
          callback(null, chunk);
        },
      });
      const out = createWriteStream(target, { flags: 'wx' });
      const done = pipeline(guard, out);
      body.pipe(guard);
      try {
        await done;
      } catch (error) {
        (body as NodeJS.ReadableStream & { unpipe(dest?: NodeJS.WritableStream): void }).unpipe(guard);
        body.resume();
        await fsp.rm(target, { force: true });
        throw error;
      }
      if (received !== declaredBytes || !format) {
        await fsp.rm(target, { force: true });
        throw new PrintError(400, 'incomplete', 'Файл передан не полностью. Попробуйте ещё раз.');
      }
      let printerAway = false;
      const validation = await call(
        OP.validateJob,
        [
          attr.name('requesting-user-name', owner),
          attr.name('job-name', name),
          attr.mime('document-format', MIME[format]),
        ],
        jobAttributes(o),
      ).catch(async (error: unknown) => {
        if (error instanceof PrintError && error.code === 'printer_unreachable') {
          printerAway = true; // the document stays; the user decides what to do
          return null;
        }
        await fsp.rm(target, { force: true });
        throw error;
      });
      if (validation && validation.status >= 0x0100) {
        await fsp.rm(target, { force: true });
        throw new PrintError(422, 'rejected', statusMessage(validation.status));
      }
      const at = isoNow(options.clock);
      const job: StoredJob = {
        id,
        owner,
        fileName: name,
        sizeBytes: received,
        format,
        copies: o.copies,
        sides: o.sides,
        colorMode: o.colorMode,
        state: printerAway ? 'held' : 'checked',
        message: printerAway
          ? 'Принтер сейчас не отвечает (выключен или нет связи). Документ сохранён: поставьте его в очередь — он напечатается сам, когда принтер включат.'
          : 'Принтер проверил задание. Нажмите «Напечатать».',
        createdAt: at,
        updatedAt: at,
        printerJobId: null,
      };
      jobs.push(job);
      await save();
      return view(job);
    },

    async print(id: string, actor: { username: string; isAdmin: boolean }): Promise<PrintJobView> {
      const job = jobs.find((j) => j.id === id && (j.owner === actor.username || actor.isAdmin));
      if (!job) throw new PrintError(404, 'not_found', 'Такого задания нет.');
      if (job.state === 'held') {
        throw new PrintError(
          409,
          'printer_away',
          'Принтер не отвечает. Поставьте документ в очередь ожидания или отмените печать.',
        );
      }
      if (job.state !== 'checked')
        throw new PrintError(409, 'not_checked', 'Это задание уже отправлено или закрыто.');
      if (now() - Date.parse(job.createdAt) > CHECKED_TTL_MS) {
        await finish(job, 'expired', 'Не подтверждено вовремя — загрузите файл ещё раз');
        throw new PrintError(409, 'expired', 'Подтверждение устарело — загрузите файл ещё раз.');
      }
      await dispatch(job, actor.username, false);
      return view(job);
    },

    /** «Напечатать, когда принтер включат»: the held document waits for the printer for up to a day. */
    async defer(id: string, actor: { username: string; isAdmin: boolean }): Promise<PrintJobView> {
      const job = jobs.find((j) => j.id === id && (j.owner === actor.username || actor.isAdmin));
      if (!job) throw new PrintError(404, 'not_found', 'Такого задания нет.');
      if (job.state !== 'held') {
        throw new PrintError(
          409,
          'not_held',
          'В очередь ожидания можно поставить только документ, который не удалось проверить на принтере.',
        );
      }
      update(job, {
        state: 'queued',
        message: 'В очереди ожидания: напечатается сам, когда принтер включат (не позже чем через сутки)',
        createdAt: isoNow(options.clock),
      });
      await save();
      options.onEvent?.({
        action: 'print.submit',
        actor: actor.username,
        detail: `${job.format.toUpperCase()}: в очередь ожидания (принтер не отвечает)`,
      });
      ensureDeferredTimer();
      void runDeferred();
      return view(job);
    },

    async cancel(id: string, actor: { username: string; isAdmin: boolean }): Promise<PrintJobView> {
      const job = jobs.find((j) => j.id === id && (j.owner === actor.username || actor.isAdmin));
      if (!job) throw new PrintError(404, 'not_found', 'Такого задания нет.');
      if (FINAL.has(job.state)) return view(job);
      if (job.printerJobId !== null) {
        const res = await call(OP.cancelJob, [
          attr.integer('job-id', job.printerJobId),
          attr.name('requesting-user-name', job.owner),
        ]);
        if (res.status >= 0x0100 && res.status !== 0x0407) {
          throw new PrintError(
            409,
            'cannot_cancel',
            'Принтер уже напечатал или не даёт отменить это задание.',
          );
        }
      }
      await finish(job, 'canceled', 'Отменено');
      options.onEvent?.({ action: 'print.cancel', actor: actor.username, detail: job.format.toUpperCase() });
      return view(job);
    },

    /** Printer state over IPP, cached for 30 s; toner levels only when the printer reports them. */
    async printerStatus(): Promise<PrinterIppStatus> {
      if (!options.printerUrl) {
        return {
          configured: false,
          reachable: null,
          state: null,
          acceptingJobs: null,
          reasons: [],
          markers: [],
          checkedAt: null,
          message: 'Печать через портал не настроена.',
        };
      }
      // Never makes the page wait for the printer (it may be asleep, off, or slow to resolve):
      // the last known state is returned at once and refreshed in the background.
      if (!printerCache || now() - printerCache.at >= 30_000)
        refreshPrinter ??= probePrinter().finally(() => {
          refreshPrinter = null;
        });
      if (printerCache) return printerCache.value;
      if (options.waitForFirstProbe) return refreshPrinter ?? probePrinter();
      return {
        configured: true,
        reachable: null,
        state: null,
        acceptingJobs: null,
        reasons: [],
        markers: [],
        checkedAt: null,
        message: 'Проверяем принтер…',
      };
    },

    async stop(): Promise<void> {
      stopped = true;
      if (deferredTimer) clearInterval(deferredTimer);
      deferredTimer = null;
      for (const timer of polling.values()) clearTimeout(timer);
      polling.clear();
      await refreshPrinter?.catch(() => undefined);
      await saving;
    },
  };

  async function probePrinter(): Promise<PrinterIppStatus> {
    {
      let value: PrinterIppStatus;
      try {
        const res = await call(OP.getPrinterAttributes, [
          attr.keyword(
            'requested-attributes',
            'printer-state',
            'printer-state-reasons',
            'printer-is-accepting-jobs',
            'marker-names',
            'marker-colors',
            'marker-levels',
          ),
        ]);
        const names = (res.attrs.get('marker-names') ?? []).map(String);
        const colors = (res.attrs.get('marker-colors') ?? []).map(String);
        const levels = (res.attrs.get('marker-levels') ?? []).map(Number);
        const state = PRINTER_STATE[Number(res.attrs.get('printer-state')?.[0])] ?? null;
        const accepting = res.attrs.get('printer-is-accepting-jobs')?.[0];
        value = {
          configured: true,
          reachable: true,
          state,
          acceptingJobs: typeof accepting === 'boolean' ? accepting : null,
          reasons: (res.attrs.get('printer-state-reasons') ?? []).map(String).filter((r) => r !== 'none'),
          // -1/-2/-3 mean "unknown": shown as no data, never as 0 %.
          markers: names.map((name, i) => ({
            name,
            color: colors[i] ?? null,
            levelPercent: (levels[i] ?? -2) >= 0 ? (levels[i] as number) : null,
          })),
          checkedAt: isoNow(options.clock),
          message:
            state === 'stopped'
              ? 'Принтер остановлен'
              : accepting === false
                ? 'Принтер не принимает задания'
                : 'Принтер на связи',
        };
      } catch (error) {
        value = {
          configured: true,
          reachable: false,
          state: null,
          acceptingJobs: null,
          reasons: [],
          markers: [],
          checkedAt: isoNow(options.clock),
          message: (error as Error).message,
        };
      }
      printerCache = { at: now(), value };
      return value;
    }
  }
}

export type PrintQueue = ReturnType<typeof createPrintQueue>;
