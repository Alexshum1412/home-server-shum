/**
 * Minimal IPP/2.0 client for the home printer (RFC 8010/8011): only the operations the portal
 * needs. The printer address comes from the owner's .env (PRINTER_IPP_URL), never from a request.
 */
import http from 'node:http';
import https from 'node:https';

export const OP = {
  printJob: 0x0002,
  validateJob: 0x0004,
  cancelJob: 0x0008,
  getJobAttributes: 0x0009,
  getPrinterAttributes: 0x000b,
} as const;

const TAG = {
  operation: 0x01,
  job: 0x02,
  end: 0x03,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  rangeOfInteger: 0x33,
  textWithoutLanguage: 0x41,
  nameWithoutLanguage: 0x42,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
} as const;

export type IppValue = string | number | boolean | { lower: number; upper: number };

export interface IppAttribute {
  tag: number;
  name: string;
  values: IppValue[];
}

export interface IppResponse {
  status: number;
  /** Attributes by name, merged over all groups (later groups win). */
  attrs: Map<string, IppValue[]>;
}

export class IppError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

export const attr = {
  keyword: (name: string, ...values: string[]): IppAttribute => ({ tag: TAG.keyword, name, values }),
  integer: (name: string, value: number): IppAttribute => ({ tag: TAG.integer, name, values: [value] }),
  name: (name: string, value: string): IppAttribute => ({
    tag: TAG.nameWithoutLanguage,
    name,
    values: [value],
  }),
  mime: (name: string, value: string): IppAttribute => ({ tag: TAG.mimeMediaType, name, values: [value] }),
};

function encodeValue(tag: number, value: IppValue): Buffer {
  if (tag === TAG.integer || tag === TAG.enum) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(Number(value));
    return b;
  }
  if (tag === TAG.boolean) return Buffer.from([value ? 1 : 0]);
  return Buffer.from(String(value), 'utf8');
}

function encodeAttribute(a: IppAttribute): Buffer {
  const parts: Buffer[] = [];
  a.values.forEach((value, i) => {
    const name = i === 0 ? Buffer.from(a.name, 'utf8') : Buffer.alloc(0);
    const data = encodeValue(a.tag, value);
    const head = Buffer.alloc(3);
    head.writeUInt8(a.tag, 0);
    head.writeUInt16BE(name.length, 1);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(data.length, 0);
    parts.push(head, name, len, data);
  });
  return Buffer.concat(parts);
}

export function encodeRequest(
  operation: number,
  requestId: number,
  printerUri: string,
  operationAttrs: IppAttribute[],
  jobAttrs: IppAttribute[] = [],
): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt8(2, 0);
  head.writeUInt8(0, 1);
  head.writeUInt16BE(operation, 2);
  head.writeInt32BE(requestId, 4);
  const op: IppAttribute[] = [
    { tag: TAG.charset, name: 'attributes-charset', values: ['utf-8'] },
    { tag: TAG.naturalLanguage, name: 'attributes-natural-language', values: ['ru'] },
    { tag: TAG.uri, name: 'printer-uri', values: [printerUri] },
    ...operationAttrs,
  ];
  const parts = [head, Buffer.from([TAG.operation]), ...op.map(encodeAttribute)];
  if (jobAttrs.length > 0) parts.push(Buffer.from([TAG.job]), ...jobAttrs.map(encodeAttribute));
  parts.push(Buffer.from([TAG.end]));
  return Buffer.concat(parts);
}

export function decodeResponse(buf: Buffer): IppResponse {
  if (buf.length < 9) throw new IppError('Принтер прислал слишком короткий ответ');
  const status = buf.readUInt16BE(2);
  const attrs = new Map<string, IppValue[]>();
  let pos = 8;
  let current: string | null = null;
  while (pos < buf.length) {
    const tag = buf.readUInt8(pos);
    pos += 1;
    if (tag === TAG.end) break;
    if (tag < 0x10) {
      current = null; // a new attribute group
      continue;
    }
    if (pos + 2 > buf.length) throw new IppError('Ответ принтера повреждён');
    const nameLen = buf.readUInt16BE(pos);
    pos += 2;
    const name = buf.subarray(pos, pos + nameLen).toString('utf8');
    pos += nameLen;
    const valueLen = buf.readUInt16BE(pos);
    pos += 2;
    if (pos + valueLen > buf.length) throw new IppError('Ответ принтера повреждён');
    const data = buf.subarray(pos, pos + valueLen);
    pos += valueLen;
    let value: IppValue;
    if ((tag === TAG.integer || tag === TAG.enum) && valueLen === 4) value = data.readInt32BE(0);
    else if (tag === TAG.boolean && valueLen === 1) value = data[0] !== 0;
    else if (tag === TAG.rangeOfInteger && valueLen === 8)
      value = { lower: data.readInt32BE(0), upper: data.readInt32BE(4) };
    else value = data.toString('utf8');
    if (nameLen > 0) {
      current = name;
      attrs.set(name, [value]);
    } else if (current) {
      attrs.get(current)?.push(value); // additional value of the same attribute
    }
  }
  return { status, attrs };
}

/** `withDocument`: the message carries document data (Print-Job). */
export type IppTransport = (
  url: string,
  body: Buffer,
  timeoutMs: number,
  withDocument?: boolean,
) => Promise<Buffer>;

/**
 * POSTs an IPP message. https:// talks TLS to the printer's self-signed certificate: it keeps the
 * documents unreadable on the home network; the address itself is fixed in the owner's config.
 */
export const httpTransport: IppTransport = (url, body, timeoutMs, withDocument = false) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(
      target,
      {
        method: 'POST',
        // A document is sent chunked, like CUPS and Windows do: the HP M283 firmware aborts a job
        // ("aborted-by-system", nothing printed) when its document comes with a Content-Length.
        headers: withDocument
          ? { 'content-type': 'application/ipp', 'transfer-encoding': 'chunked' }
          : { 'content-type': 'application/ipp', 'content-length': body.length },
        timeout: timeoutMs,
        ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            req.destroy(new IppError('Слишком большой ответ принтера'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if ((res.statusCode ?? 0) !== 200) reject(new IppError(`Принтер ответил HTTP ${res.statusCode}`));
          else resolve(Buffer.concat(chunks));
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new IppError('Принтер не ответил вовремя')));
    req.on('error', (error) =>
      reject(
        error instanceof IppError
          ? error
          : new IppError(`Принтер недоступен (${(error as NodeJS.ErrnoException).code ?? error.message})`),
      ),
    );
    if (withDocument) {
      for (let pos = 0; pos < body.length; pos += 64 * 1024) req.write(body.subarray(pos, pos + 64 * 1024));
      req.end();
    } else {
      req.end(body);
    }
  });

/** printer-uri for the message: http(s):// → ipp(s):// (what the printer itself advertises). */
export function printerUriOf(url: string): string {
  return url.replace(/^http:/i, 'ipp:').replace(/^https:/i, 'ipps:');
}

export const JOB_STATE: Record<
  number,
  'pending' | 'held' | 'processing' | 'stopped' | 'canceled' | 'aborted' | 'completed'
> = {
  3: 'pending',
  4: 'held',
  5: 'processing',
  6: 'stopped',
  7: 'canceled',
  8: 'aborted',
  9: 'completed',
};

export const PRINTER_STATE: Record<number, 'idle' | 'processing' | 'stopped'> = {
  3: 'idle',
  4: 'processing',
  5: 'stopped',
};

/** Russian explanation of an IPP status code for the family. */
export function statusMessage(status: number): string {
  if (status < 0x0100) return 'Принтер принял задание';
  switch (status) {
    case 0x040a:
      return 'Принтер не поддерживает этот формат файла';
    case 0x0411:
      return 'Файл повреждён — принтер не может его прочитать';
    case 0x0418:
    case 0x0419:
    case 0x041a:
      return 'Файл защищён паролем или запретом печати';
    case 0x041b:
      return 'Принтер не смог напечатать этот файл';
    case 0x0408:
      return 'Файл слишком большой для принтера';
    case 0x040b:
      return 'Принтер не поддерживает выбранные настройки печати';
    case 0x0506:
      return 'Принтер сейчас не принимает задания';
    case 0x0507:
    case 0x0505:
      return 'Принтер занят — попробуйте через минуту';
    default:
      return status >= 0x0500
        ? `Ошибка принтера (код 0x${status.toString(16)})`
        : `Принтер отклонил задание (код 0x${status.toString(16)})`;
  }
}
