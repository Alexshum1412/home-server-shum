import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { StorageRoot, StorageSpace, UploadResponse } from '../../../shared/api.ts';
import { browserUploadApi } from './upload-api.ts';
import {
  browserSessionMemory,
  createUploader,
  type Uploader,
  type UploadItem,
  type UploadSnapshot,
} from './uploader.ts';

const EMPTY: UploadSnapshot = {
  items: [],
  running: false,
  checking: null,
  partialCheck: false,
  doneCount: 0,
  skippedCount: 0,
  failedCount: 0,
  leftCount: 0,
  bytesTotal: 0,
  bytesSent: 0,
};

export interface UseUploaderConfig {
  root: StorageRoot;
  space: StorageSpace;
  strip: boolean;
  checkDuplicates: boolean;
  afterSaved?: (item: UploadItem, saved: UploadResponse) => Promise<void>;
}

/** The queue of one page: its state as the page's own, the choices read when a file starts (not when the page was drawn). */
export function useUploader(config: UseUploaderConfig): { uploader: Uploader; snapshot: UploadSnapshot } {
  const latest = useRef(config);
  latest.current = config;
  const [snapshot, setSnapshot] = useState<UploadSnapshot>(EMPTY);
  const uploader = useMemo(
    () =>
      createUploader({
        root: config.root,
        space: config.space,
        api: browserUploadApi(),
        memory: browserSessionMemory(),
        strip: () => latest.current.strip,
        checkDuplicates: () => latest.current.checkDuplicates,
        onChange: setSnapshot,
        afterSaved: (item, saved) => latest.current.afterSaved?.(item, saved) ?? Promise.resolve(),
      }),
    [config.root, config.space],
  );
  // A page that is left while the queue works: the work is stopped, what was sent stays for a day.
  useEffect(() => () => uploader.stop(), [uploader]);
  return { uploader, snapshot };
}
