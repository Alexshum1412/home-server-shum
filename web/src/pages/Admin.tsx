import { FileDown, Lock, RefreshCw, ScrollText, ShieldCheck, TriangleAlert, Users } from 'lucide-preact';
import { useState } from 'preact/hooks';
import type { AuditResponse, HealthResponse, RefreshResponse, UsersResponse } from '../../../shared/api.ts';
import { apiDownload, apiPost, toFailure } from '../api.ts';
import { TableWrap } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatDateTime } from '../lib/format.ts';
import { auditActionLabel, ROLE_LABEL } from '../lib/labels.ts';
import { useData, useIsAdmin } from '../state.tsx';

type ActionState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; text: string }
  | { kind: 'error'; text: string };

function ActionMessage(props: { state: ActionState }) {
  const { state } = props;
  return (
    <p class={`action-message${state.kind === 'error' ? ' action-message--error' : ''}`} aria-live="polite">
      {state.kind === 'done' || state.kind === 'error' ? state.text : null}
    </p>
  );
}

function ServicesBlock() {
  const { services } = useData();
  const [state, setState] = useState<ActionState>({ kind: 'idle' });
  const configError = services.data?.configError ?? null;

  async function refreshNow() {
    setState({ kind: 'busy' });
    try {
      const fresh = await apiPost<RefreshResponse>('/api/services/refresh', {});
      services.replace(fresh);
      setState({ kind: 'done', text: 'Проверка завершена, состояния сервисов обновлены.' });
    } catch (error) {
      setState({ kind: 'error', text: toFailure(error).message });
    }
  }

  return (
    <section class="page-section">
      <h2 class="section-title">
        <RefreshCw class="section-title__icon" size={20} aria-hidden="true" />
        Проверка сервисов
      </h2>
      <p class="section-lead">
        Портал сам проверяет сервисы раз в минуту. Кнопка запускает проверку сразу — не чаще раза в 10 секунд.
      </p>
      {configError ? (
        <div class="banner banner--warn">
          <TriangleAlert class="banner__icon" size={20} aria-hidden="true" />
          <div class="banner__body">
            <p class="banner__title">Файл настроек сервисов не принят</p>
            <p class="banner__text">{configError}</p>
          </div>
        </div>
      ) : null}
      <div class="action-row">
        <button
          type="button"
          class="button button--secondary"
          onClick={refreshNow}
          disabled={state.kind === 'busy'}
        >
          <RefreshCw size={18} aria-hidden="true" />
          {state.kind === 'busy' ? 'Проверяем…' : 'Проверить сервисы сейчас'}
        </button>
        {services.data ? (
          <p class="meta">
            Последняя сводка <RelativeTime value={services.data.generatedAt} />
          </p>
        ) : null}
      </div>
      <ActionMessage state={state} />
    </section>
  );
}

function UsersBlock() {
  const users = useResource<UsersResponse>('/api/admin/users');
  let content = null;
  if (users.data) {
    content =
      users.data.users.length === 0 ? (
        <p class="section-lead">Пользователей нет.</p>
      ) : (
        <TableWrap labelledBy="users-title">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Имя</th>
                <th scope="col">Логин</th>
                <th scope="col">Роль</th>
                <th scope="col">Создан</th>
                <th scope="col">Последний вход</th>
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((user) => (
                <tr key={user.id}>
                  <th scope="row">{user.displayName}</th>
                  <td class="table__nowrap">{user.username}</td>
                  <td>{ROLE_LABEL[user.role]}</td>
                  <td class="table__nowrap">{formatDateTime(user.createdAt)}</td>
                  <td class="table__nowrap">
                    {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Входов не было'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      );
  } else if (users.error) {
    content = <ErrorState failure={users.error} onRetry={users.reload} busy={users.loading} level={3} />;
  } else {
    content = <Loading label="Загружаем пользователей…" />;
  }
  return (
    <section class="page-section">
      <h2 id="users-title" class="section-title">
        <Users class="section-title__icon" size={20} aria-hidden="true" />
        Пользователи
      </h2>
      <p class="section-lead">
        Только просмотр. Добавлять и удалять пользователей и менять пароли можно на домашнем компьютере
        командой <code>npm.cmd run user</code> (действия add, list, passwd, remove).
      </p>
      {content}
    </section>
  );
}

function AuditBlock() {
  const audit = useResource<AuditResponse>('/api/admin/audit?limit=100');
  let content = null;
  if (audit.data) {
    const entries = [...audit.data.entries].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    content =
      entries.length === 0 ? (
        <p class="section-lead">Записей пока нет.</p>
      ) : (
        <TableWrap labelledBy="audit-title">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Время</th>
                <th scope="col">Действие</th>
                <th scope="col">Кто</th>
                <th scope="col">Адрес</th>
                <th scope="col">Подробности</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.time}-${entry.action}-${index}`}>
                  <td class="table__nowrap">{formatDateTime(entry.time)}</td>
                  <td>{auditActionLabel(entry.action)}</td>
                  <td class="table__nowrap">{entry.actor ?? 'Без входа'}</td>
                  <td class="table__nowrap">{entry.ip ?? 'Нет данных'}</td>
                  <td class="table__note">{entry.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      );
  } else if (audit.error) {
    content = <ErrorState failure={audit.error} onRetry={audit.reload} busy={audit.loading} level={3} />;
  } else {
    content = <Loading label="Загружаем журнал…" />;
  }
  return (
    <section class="page-section">
      <div class="section-head">
        <h2 id="audit-title" class="section-title">
          <ScrollText class="section-title__icon" size={20} aria-hidden="true" />
          Журнал действий
        </h2>
        <button type="button" class="button button--quiet" onClick={audit.reload} disabled={audit.loading}>
          <RefreshCw size={18} aria-hidden="true" />
          Обновить журнал
        </button>
      </div>
      <p class="section-lead">Последние 100 записей, новые сверху. Пароли и ключи в журнал не попадают.</p>
      {content}
    </section>
  );
}

function DiagnosticsBlock() {
  const health = useResource<HealthResponse>('/api/health');
  const [state, setState] = useState<ActionState>({ kind: 'idle' });

  async function download() {
    setState({ kind: 'busy' });
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const { blob, filename } = await apiDownload('/api/admin/diagnostics', `diagnostika-${stamp}.json`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setState({ kind: 'done', text: `Файл ${filename} сохранён в папку загрузок.` });
    } catch (error) {
      setState({ kind: 'error', text: toFailure(error).message });
    }
  }

  return (
    <section class="page-section">
      <h2 class="section-title">
        <FileDown class="section-title__icon" size={20} aria-hidden="true" />
        Диагностика
      </h2>
      <p class="section-lead">
        Файл JSON для разбора проблем: версия, настройки без секретов, состояние системы и сервисов. Паролей,
        ключей и cookie в нём нет.
      </p>
      <div class="action-row">
        <button
          type="button"
          class="button button--secondary"
          onClick={download}
          disabled={state.kind === 'busy'}
        >
          <FileDown size={18} aria-hidden="true" />
          {state.kind === 'busy' ? 'Готовим файл…' : 'Скачать диагностику'}
        </button>
        <p class="meta">
          {health.data
            ? `Версия портала ${health.data.version}`
            : health.error
              ? 'Версия портала: нет данных'
              : 'Версия портала…'}
        </p>
      </div>
      <ActionMessage state={state} />
    </section>
  );
}

export function AdminPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <div class="page">
        <PageHeader title="Администрирование" icon={ShieldCheck} />
        <EmptyState icon={Lock} title="Раздел доступен только администраторам">
          <p>Если вам нужно что-то изменить в настройках портала, попросите администратора семьи.</p>
        </EmptyState>
      </div>
    );
  }
  return (
    <div class="page">
      <PageHeader
        title="Администрирование"
        icon={ShieldCheck}
        lead="Наблюдение и диагностика. Команды на компьютере отсюда не выполняются."
      />
      <ServicesBlock />
      <UsersBlock />
      <AuditBlock />
      <DiagnosticsBlock />
    </div>
  );
}
