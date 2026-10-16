import type { PrinterInfo, PrinterState } from '../../../shared/api.ts';

const SUFFIX = ' (по данным Windows)';

interface RawPrinter {
  name: string;
  isDefault: boolean;
  printerStatus: number;
  detectedErrorState: number;
  workOffline: boolean;
}

/** Win32_Printer.DetectedErrorState values that mean printing cannot continue. */
const ERROR_STATES: Record<number, string> = {
  4: 'Нет бумаги',
  6: 'Закончился тонер',
  7: 'Открыта крышка',
  8: 'Замятие бумаги',
  10: 'Требуется обслуживание',
  11: 'Выходной лоток переполнен',
};

function toRaw(value: unknown): RawPrinter | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || v.name.trim() === '') return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    name: v.name.trim(),
    isDefault: v.isDefault === true,
    printerStatus: num(v.printerStatus),
    detectedErrorState: num(v.detectedErrorState),
    workOffline: v.workOffline === true,
  };
}

function describe(printer: RawPrinter): { state: PrinterState; message: string } {
  let state: PrinterState;
  let message: string;
  if (printer.workOffline || printer.printerStatus === 7) {
    state = 'offline';
    message = 'Принтер недоступен';
  } else {
    switch (printer.printerStatus) {
      case 3:
        state = 'ready';
        message = 'Готов к печати';
        break;
      case 4:
        state = 'printing';
        message = 'Печатает';
        break;
      case 5:
        state = 'ready';
        message = 'Прогревается';
        break;
      case 6:
        state = 'error';
        message = 'Печать остановлена';
        break;
      default:
        state = 'unknown';
        message = 'Windows не сообщает состояние принтера';
    }
  }

  const errorText = ERROR_STATES[printer.detectedErrorState];
  if (errorText) {
    state = 'error';
    message = errorText;
  } else if (printer.detectedErrorState === 9) {
    state = 'offline';
    message = 'Принтер недоступен';
  } else if (printer.detectedErrorState === 3) {
    message = `${message}. Мало бумаги`;
  } else if (printer.detectedErrorState === 5) {
    message = `${message}. Мало тонера`;
  }
  return { state, message: message + SUFFIX };
}

/**
 * Picks PRINTER_NAME (case-insensitive) or the Windows default printer and maps its state.
 * Only what Windows reports is used — ink/toner levels are never invented.
 */
export function parsePrinters(raw: unknown, printerName: string | null): Omit<PrinterInfo, 'collectedAt'> {
  const list = (Array.isArray(raw) ? raw : [raw]).map(toRaw).filter((p): p is RawPrinter => p !== null);
  if (printerName) {
    const wanted = printerName.toLowerCase();
    const found = list.find((p) => p.name.toLowerCase() === wanted);
    if (!found) {
      return {
        name: printerName,
        state: 'not_found',
        message: `Принтер «${printerName}» не найден в Windows`,
      };
    }
    return { name: found.name, ...describe(found) };
  }
  if (list.length === 0) {
    return { name: null, state: 'not_configured', message: 'В Windows не установлено ни одного принтера' };
  }
  const chosen = list.find((p) => p.isDefault);
  if (!chosen) {
    return { name: null, state: 'not_configured', message: 'В Windows не выбран принтер по умолчанию' };
  }
  return { name: chosen.name, ...describe(chosen) };
}
