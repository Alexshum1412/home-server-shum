/** HTTP byte ranges («Range: bytes=…») for files served in pieces: video seeking, resumed downloads. */

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * One range of a file of `size` bytes. `null` — no (usable) Range header: send the whole file;
 * `'invalid'` — the range lies outside the file: answer 416. Several ranges are not supported
 * and count as «whole file».
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | 'invalid' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || size <= 0) return null;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return null;
  let start = first === '' ? size - Number(last) : Number(first);
  let end = first === '' || last === '' ? size - 1 : Number(last);
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return 'invalid';
  return { start, end };
}
