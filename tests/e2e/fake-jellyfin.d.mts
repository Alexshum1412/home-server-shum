export const FAKE_KEY: string;
export interface FakeItem {
  Id: string;
  Name: string;
  Type: string;
  [key: string]: unknown;
}
export const ITEMS: FakeItem[];
export interface FakeJellyfin {
  close: () => Promise<void>;
  requests: string[];
  /** A file lands in the media folder: it shows up only after the next library refresh. */
  stage: (item: FakeItem & { parent: string }) => void;
  /** Changes the day an item came into the library (days before now). */
  setAddedDaysAgo: (itemId: string, days: number) => void;
}
export function startFakeJellyfin(options: {
  port: number;
  videoFile: string;
  key?: string;
}): Promise<FakeJellyfin>;
