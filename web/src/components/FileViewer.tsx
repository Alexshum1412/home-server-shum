import { Download, ExternalLink, X } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { formatBytes } from '../lib/format.ts';

export type ViewKind = 'image' | 'video' | 'audio' | 'text' | 'pdf';

/** What a stored file may be shown as inside the page (the server decides again: only safe types are served inline). */
export function viewKindOf(name: string): ViewKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'm4v', 'mov', 'webm'].includes(ext)) return 'video';
  if (['mp3'].includes(ext)) return 'audio';
  if (ext === 'txt') return 'text';
  if (ext === 'pdf') return 'pdf';
  return null;
}

const TEXT_MAX_BYTES = 1024 * 1024;

/**
 * A file shown in a window of the page: pictures, video, sound and plain text right here; a PDF through the
 * browser's own viewer when it can show it, with «Открыть в новой вкладке» and «Скачать» always at hand. The
 * server sends these files with a policy that forbids scripts, so nothing in a file can run in the portal.
 */
export function FileViewer(props: {
  name: string;
  sizeBytes: number | null;
  inlineUrl: string;
  downloadUrl: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const kind = viewKindOf(props.name);
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (kind !== 'text') return;
    if ((props.sizeBytes ?? 0) > TEXT_MAX_BYTES) {
      setProblem(true);
      return;
    }
    let cancelled = false;
    fetch(props.inlineUrl, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error('not ok'))))
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch(() => {
        if (!cancelled) setProblem(true);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, props.inlineUrl, props.sizeBytes]);

  return (
    <dialog
      ref={ref}
      class="sheet-dialog file-viewer"
      aria-labelledby={`${ids}-title`}
      onClose={props.onClose}
    >
      <div class="sheet-dialog__head">
        <h2 id={`${ids}-title`} class="section-title">
          {props.name}
        </h2>
        <button type="button" class="button button--quiet" onClick={() => ref.current?.close()}>
          <X size={20} aria-hidden="true" />
          Закрыть
        </button>
      </div>
      {kind === 'image' ? <img class="file-viewer__media" src={props.inlineUrl} alt={props.name} /> : null}
      {kind === 'video' ? (
        // biome-ignore lint/a11y/useMediaCaption: family files have no caption tracks
        <video class="file-viewer__media" src={props.inlineUrl} controls preload="metadata" />
      ) : null}
      {kind === 'audio' ? (
        // biome-ignore lint/a11y/useMediaCaption: family files have no caption tracks
        <audio class="file-viewer__media" src={props.inlineUrl} controls preload="metadata" />
      ) : null}
      {kind === 'text' ? (
        problem ? (
          <p class="banner banner--info">
            Файл слишком большой или не открылся. Скачайте его, чтобы прочитать
            {props.sizeBytes !== null ? ` (${formatBytes(props.sizeBytes)})` : ''}.
          </p>
        ) : text === null ? (
          <p class="meta" role="status">
            Открываем…
          </p>
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable from the keyboard
          <section aria-label="Текст файла" tabIndex={0} class="file-viewer__scroll">
            <pre class="file-viewer__text">{text}</pre>
          </section>
        )
      ) : null}
      {kind === 'pdf' ? (
        <p class="meta">PDF показывает сам браузер в новой вкладке (так надёжнее, чем внутри страницы).</p>
      ) : null}
      <div class="action-row">
        <a class="button button--secondary" href={props.inlineUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={18} aria-hidden="true" />
          Открыть в новой вкладке<span class="visually-hidden"> (откроется отдельно)</span>
        </a>
        <a class="button button--secondary" href={props.downloadUrl} download={props.name}>
          <Download size={18} aria-hidden="true" />
          Скачать
        </a>
      </div>
    </dialog>
  );
}
