import { House, MapPinOff } from 'lucide-preact';
import { EmptyState } from '../components/EmptyState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';

export function NotFoundPage() {
  return (
    <div class="page">
      <PageHeader title="Страница не найдена" />
      <EmptyState
        icon={MapPinOff}
        title="Такой страницы в портале нет"
        actions={
          <a class="button button--secondary" href="/">
            <House size={18} aria-hidden="true" />
            На главную
          </a>
        }
      >
        <p>Возможно, ссылка устарела или в адресе опечатка.</p>
      </EmptyState>
    </div>
  );
}
