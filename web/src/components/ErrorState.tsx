import { RefreshCw, TriangleAlert, WifiOff } from 'lucide-preact';
import { type ApiFailure, NO_CONNECTION } from '../api.ts';

/** A failed data view with the reason and a retry button. */
export function ErrorState(props: {
  failure: ApiFailure;
  onRetry: () => void;
  busy?: boolean;
  level?: 2 | 3;
}) {
  const { failure } = props;
  const Icon = failure.unreachable ? WifiOff : TriangleAlert;
  const Heading = props.level === 3 ? 'h3' : 'h2';
  const title = failure.unreachable ? NO_CONNECTION : 'Не удалось загрузить данные';
  return (
    <div class="empty empty--error">
      <span class="empty__icon">
        <Icon size={24} aria-hidden="true" />
      </span>
      <Heading class="empty__title">{title}</Heading>
      {failure.message !== title ? <p class="empty__text">{failure.message}</p> : null}
      <div class="empty__actions">
        <button type="button" class="button button--secondary" onClick={props.onRetry} disabled={props.busy}>
          <RefreshCw size={18} aria-hidden="true" />
          {props.busy ? 'Проверяем…' : 'Повторить'}
        </button>
      </div>
    </div>
  );
}
