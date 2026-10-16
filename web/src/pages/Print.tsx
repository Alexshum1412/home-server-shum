import { ExternalLink, Info, Printer } from 'lucide-preact';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { findService, openableUrl, PRINTER_STATE } from '../lib/labels.ts';
import { useData } from '../state.tsx';

export function PrintPage() {
  const { system, services } = useData();
  const printer = system.data?.printer;
  const printService = findService(services.data?.services, 'print');
  const printUrl = openableUrl(printService);

  let status = null;
  if (printer) {
    status = (
      <div class="service-panel">
        <div class="service-panel__status">
          <StatusBadge status={PRINTER_STATE[printer.state]} />
          <p class="meta">
            По данным Windows
            {printer.collectedAt ? (
              <>
                , обновлено <RelativeTime value={printer.collectedAt} />
              </>
            ) : null}
          </p>
        </div>
        <dl class="facts">
          <div class="facts__row">
            <dt>Принтер</dt>
            <dd>{printer.name ?? 'Нет данных'}</dd>
          </div>
          <div class="facts__row">
            <dt>Что сообщает Windows</dt>
            <dd>{printer.message}</dd>
          </div>
        </dl>
        {printUrl ? (
          <a class="button button--secondary" href={printUrl} target="_blank" rel="noopener noreferrer">
            Открыть сервис печати
            <ExternalLink size={18} aria-hidden="true" />
            <span class="visually-hidden"> (откроется в новой вкладке)</span>
          </a>
        ) : null}
      </div>
    );
  } else if (system.error) {
    status = <ErrorState failure={system.error} onRetry={system.refresh} busy={system.loading} />;
  } else {
    status = <Loading label="Узнаём состояние принтера…" />;
  }

  return (
    <div class="page">
      <PageHeader title="Печать" icon={Printer} />
      {status}
      <section class="prose-block">
        <h2 class="section-title">
          <Info class="section-title__icon" size={20} aria-hidden="true" />
          Печать из портала пока недоступна
        </h2>
        <p>
          Здесь видно только, готов ли принтер, — так, как об этом сообщает Windows на домашнем компьютере.
          Отправить документ на печать прямо из портала пока нельзя: печатайте, как обычно, с компьютера, к
          которому подключён принтер.
        </p>
        <p>
          Уровень чернил и бумаги портал не показывает: Windows не сообщает эти данные надёжно, а угадывать мы
          не будем.
        </p>
      </section>
    </div>
  );
}
