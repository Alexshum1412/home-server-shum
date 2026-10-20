/** Types of the pages added on 20.10.2026: deadlines, morning digest, family status, safety (decoys, devices, incidents). */

// --- deadlines («Сроки и гарантии») -------------------------------------------------------------

export type DeadlineKind = 'document' | 'warranty' | 'subscription' | 'service' | 'other';

export interface DeadlineInput {
  title: string;
  kind: DeadlineKind;
  /** The day it ends, «YYYY-MM-DD». */
  expires: string;
  /** How many days before the end to remind (each once). */
  remindDays: number[];
  note: string;
  /** Visible only to its author (default) or to the whole family. */
  shared: boolean;
}

export interface DeadlineView extends DeadlineInput {
  id: string;
  owner: string;
  ownerName: string;
  /** Days left: negative when it is over. */
  daysLeft: number;
  mine: boolean;
}

export interface DeadlinesResponse {
  deadlines: DeadlineView[];
}

// --- morning digest ------------------------------------------------------------------------------

export interface DigestSettings {
  enabled: boolean;
  /** Local time of the daily run, «HH:MM». */
  time: string;
  /** Where the weather is taken for (empty — no weather). */
  city: string;
  latitude: number | null;
  longitude: number | null;
  currency: boolean;
  /** Telegram is possible: a bot token file exists. */
  telegramReady: boolean;
}

export interface DigestMine {
  enabled: boolean;
  telegramChatId: string;
  last: { at: string; text: string; how: 'model' | 'template' } | null;
}

export interface DigestResponse {
  settings: DigestSettings;
  mine: DigestMine;
  isAdmin: boolean;
}

// --- family status, health --------------------------------------------------------------------

export type StatusLevel = 'ok' | 'warn' | 'bad' | 'unknown';

export interface StatusItem {
  id: string;
  title: string;
  level: StatusLevel;
  text: string;
}

export interface FamilyStatusResponse {
  generatedAt: string;
  level: StatusLevel;
  headline: string;
  items: StatusItem[];
}

export interface DiskForecast {
  volume: string;
  freeBytes: number;
  /** Days until the free space reaches the reserve at the speed of the last two weeks; null — not shrinking or not enough data. */
  daysLeft: number | null;
  perDayBytes: number | null;
  points: number;
}

export interface Incident {
  id: string;
  at: string;
  kind: 'shutdown' | 'program' | 'backup' | 'disk' | 'device' | 'decoy' | 'network' | 'login' | 'other';
  title: string;
  detail: string;
}

export interface NetworkDevice {
  mac: string;
  ip: string;
  name: string;
  /** The administrator said «this is ours». */
  known: boolean;
  firstSeen: string;
  lastSeen: string;
  online: boolean;
}

export interface SafetyResponse {
  generatedAt: string;
  forecast: DiskForecast[];
  incidents: Incident[];
  devices: NetworkDevice[];
  decoys: Array<{ space: 'shared'; path: string; touched: number; lastTouchedAt: string | null }>;
  internet: { up: boolean | null; dnsUp: boolean | null; checkedAt: string | null };
}
