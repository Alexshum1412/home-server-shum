export const FAKE_KEY: string;
export interface FakeItem {
  Id: string;
  Name: string;
  Type: string;
  [key: string]: unknown;
}
export const ITEMS: FakeItem[];
export function startFakeJellyfin(options: {
  port: number;
  videoFile: string;
  key?: string;
}): Promise<{ close: () => Promise<void>; requests: string[] }>;
