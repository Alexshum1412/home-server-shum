import { Clapperboard, Download, ExternalLink, FolderOpen, Images, Smartphone, Wrench } from 'lucide-preact';
import type { ServiceStatus } from '../../../shared/api.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import type { IconComponent } from '../components/icons.ts';
import { PageHeader } from '../components/PageHeader.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import {
  findService,
  openableUrl,
  SERVICE_PAGES,
  SERVICE_STATE,
  type ServicePageKind,
} from '../lib/labels.ts';
import { useData } from '../state.tsx';

const ICONS: Record<ServicePageKind, IconComponent> = {
  media: Clapperboard,
  photos: Images,
  files: FolderOpen,
  downloads: Download,
};

/** Why a service that is set up cannot be opened right now. */
function unavailableTitle(service: ServiceStatus | undefined): string {
  switch (service?.state) {
    case 'offline':
      return 'Сервис сейчас не отвечает';
    case 'degraded':
      return 'Сервис отвечает с ошибкой';
    case 'disabled':
      return 'Сервис выключен администратором';
    case 'unknown':
      return 'Сервис ещё не проверялся';
    default:
      return 'Сервис ещё не настроен';
  }
}

function PhotoBackupNote() {
  return (
    <section class="prose-block">
      <h2 class="section-title">
        <Smartphone class="section-title__icon" size={20} aria-hidden="true" />
        Копии фото с телефона
      </h2>
      <p>
        Автоматическое сохранение снимков с телефонов настраивается вместе с фотосервисом: в его приложении
        для телефона включается резервное копирование.
      </p>
      <p>
        На iPhone фоновая выгрузка ограничена системой: iOS решает сама, когда разрешить приложению работать в
        фоне. Надёжнее всего снимки уходят, когда приложение открыто. Как это работает именно у вас, станет
        ясно после проверки на ваших телефонах, поэтому заранее мы этого не обещаем.
      </p>
    </section>
  );
}

export function ServicePage(props: { kind: ServicePageKind }) {
  const { services } = useData();
  const copy = SERVICE_PAGES[props.kind];
  const service = findService(services.data?.services, props.kind);
  const url = openableUrl(service);
  const Icon = ICONS[props.kind];
  const loaded = services.data !== null;

  let body = null;
  if (!loaded && services.error) {
    body = <ErrorState failure={services.error} onRetry={services.refresh} busy={services.loading} />;
  } else if (!loaded) {
    body = <Loading label="Проверяем сервис…" />;
  } else {
    const status = service ? SERVICE_STATE[service.state] : SERVICE_STATE.not_configured;
    body = (
      <>
        <div class={url ? 'service-panel service-panel--on' : 'service-panel'}>
          <div class="service-panel__status">
            <StatusBadge status={status} />
            {service?.checkedAt ? (
              <p class="meta">
                Проверено <RelativeTime value={service.checkedAt} />
              </p>
            ) : null}
          </div>
          {service?.description ? <p class="service-panel__desc">{service.description}</p> : null}
          {url ? (
            <>
              <a
                class="button button--primary button--large"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {copy.openLabel}
                <ExternalLink size={20} aria-hidden="true" />
                <span class="visually-hidden"> (откроется в новой вкладке)</span>
              </a>
              <p class="meta">Откроется в новой вкладке. Вход — с учётной записью этого сервиса.</p>
            </>
          ) : (
            <EmptyState icon={Wrench} title={unavailableTitle(service)}>
              <p>{service?.message ?? 'Сервис пока не установлен на домашний компьютер.'}</p>
              <p>
                <strong>Что нужно сделать: </strong>
                {service?.hint ?? copy.adminTodo}
              </p>
            </EmptyState>
          )}
        </div>
        {!url ? (
          <section class="prose-block">
            <h2 class="section-title">Что здесь будет</h2>
            <p>{copy.purpose}</p>
          </section>
        ) : null}
      </>
    );
  }

  return (
    <div class="page">
      <PageHeader title={service?.name ?? copy.name} icon={Icon} />
      {body}
      {props.kind === 'photos' ? <PhotoBackupNote /> : null}
    </div>
  );
}
