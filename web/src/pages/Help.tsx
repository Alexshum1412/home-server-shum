import { Globe, House, Laptop, Smartphone, TriangleAlert } from 'lucide-preact';
import type { ConnectionResponse } from '../../../shared/api.ts';
import { CopyField } from '../components/CopyField.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { useResource } from '../hooks/useResource.ts';
import { useIsAdmin } from '../state.tsx';

function MainAddress(props: { data: ConnectionResponse }) {
  const { tailnetUrl } = props.data;
  return (
    <section class="prose-block">
      <h2 class="section-title">
        <Globe class="section-title__icon" size={20} aria-hidden="true" />
        Основной адрес
      </h2>
      {tailnetUrl ? (
        <>
          <CopyField label="Адрес портала" value={tailnetUrl} />
          <p>
            Работает из любого места — дома, в дороге, в другой стране, — когда на телефоне или компьютере
            включено приложение Tailscale и выполнен вход в семейную сеть.
          </p>
        </>
      ) : (
        <p>
          Основной адрес ещё не настроен. Его включает администратор на домашнем компьютере; после этого адрес
          появится здесь.
        </p>
      )}
    </section>
  );
}

function FirstSteps() {
  return (
    <section class="prose-block">
      <h2 class="section-title">Как подключить новое устройство</h2>
      <ol class="steps">
        <li>Установите приложение Tailscale из App Store, Google Play или с сайта Tailscale.</li>
        <li>Войдите в семейную сеть Tailscale: приглашение присылает администратор.</li>
        <li>Включите Tailscale и откройте основной адрес в браузере.</li>
        <li>Войдите в портал под своим именем и паролем.</li>
      </ol>
    </section>
  );
}

function InstallSteps() {
  return (
    <section class="prose-block">
      <h2 class="section-title">Значок на экране, как у приложения</h2>
      <div class="platforms">
        <div class="platform">
          <h3 class="platform__title">
            <Smartphone size={20} aria-hidden="true" />
            iPhone и iPad
          </h3>
          <p>Откройте портал в Safari, нажмите «Поделиться», затем «На экран „Домой“».</p>
        </div>
        <div class="platform">
          <h3 class="platform__title">
            <Smartphone size={20} aria-hidden="true" />
            Android
          </h3>
          <p>Откройте портал в Chrome, нажмите меню (три точки) и выберите «Добавить на главный экран».</p>
        </div>
        <div class="platform">
          <h3 class="platform__title">
            <Laptop size={20} aria-hidden="true" />
            Windows
          </h3>
          <p>
            Откройте портал в Chrome или Edge и выберите «Установить приложение» в меню или в адресной строке.
          </p>
        </div>
      </div>
      <p class="meta">Значок открывает портал одним нажатием. Tailscale при этом должен быть включён.</p>
    </section>
  );
}

function LanAddress(props: { data: ConnectionResponse; isAdmin: boolean }) {
  const { lanUrl, localUrl, lanProblem } = props.data;
  return (
    <section class="prose-block">
      <h2 class="section-title">
        <House class="section-title__icon" size={20} aria-hidden="true" />
        Дома, если пропал интернет
      </h2>
      {lanUrl ? (
        <>
          <CopyField label="Адрес в домашней сети" value={lanUrl} />
          <p>
            Запасной адрес работает только в домашнем Wi‑Fi или по кабелю, и интернет для него не нужен. Он
            открывается по обычному HTTP, без шифрования, поэтому установить портал как приложение по нему
            нельзя. Пользуйтесь им, только если основной адрес почему-то не открывается.
          </p>
        </>
      ) : (
        <p>
          Запасной адрес для домашней сети пока не включён, поэтому дома тоже пользуйтесь основным адресом.
          Если запасной адрес нужен, попросите администратора его включить.
        </p>
      )}
      {props.isAdmin && lanProblem ? (
        <p class="banner banner--warn" role="status">
          Запасной адрес включён в настройках, но портал его не слушает: {lanProblem}. Проверьте IP компьютера
          в домашней сети (команда <code>scriptslan-mode.cmd status</code>).
        </p>
      ) : null}
      {props.isAdmin && !lanUrl ? (
        <p class="meta">
          Администратору: включить запасной адрес можно командой <code>scriptslan-mode.cmd on</code> на
          домашнем компьютере (она сама создаёт правило брандмауэра только для домашней сети и спрашивает
          подтверждение).
        </p>
      ) : null}
      {/* The local address works only in a browser on the server itself: useless on a phone. */}
      {props.isAdmin ? (
        <>
          <CopyField label="Адрес только для самого домашнего компьютера" value={localUrl} />
          <p class="meta">
            Открывается только в браузере на самом домашнем компьютере. С телефона или ноутбука по нему не
            зайти.
          </p>
        </>
      ) : null}
    </section>
  );
}

function Limits(props: { hasLanAddress: boolean }) {
  return (
    <section class="prose-block">
      <h2 class="section-title">
        <TriangleAlert class="section-title__icon" size={20} aria-hidden="true" />
        Когда портал не откроется
      </h2>
      <ul class="plain-list">
        <li>Домашний компьютер выключен, спит или перезагружается.</li>
        <li>
          {props.hasLanAddress
            ? 'Дома пропал интернет: из других мест портал недоступен, дома может выручить запасной адрес.'
            : 'Дома пропал интернет: из других мест портал недоступен.'}
        </li>
        <li>На вашем телефоне или ноутбуке выключен Tailscale или выполнен выход из семейной сети.</li>
      </ul>
    </section>
  );
}

export function HelpPage() {
  const connection = useResource<ConnectionResponse>('/api/connection');
  const isAdmin = useIsAdmin();
  let addresses = null;
  if (connection.data) {
    addresses = (
      <>
        <MainAddress data={connection.data} />
        <FirstSteps />
        <InstallSteps />
        <LanAddress data={connection.data} isAdmin={isAdmin} />
      </>
    );
  } else if (connection.error) {
    addresses = (
      <ErrorState failure={connection.error} onRetry={connection.reload} busy={connection.loading} />
    );
  } else {
    addresses = <Loading label="Загружаем адреса…" />;
  }
  return (
    <div class="page page--narrow">
      <PageHeader
        title="Подключение"
        icon={Smartphone}
        lead="Как открыть семейный портал с телефона, планшета или ноутбука — дома и в поездке."
      />
      {addresses}
      <Limits hasLanAddress={Boolean(connection.data?.lanUrl)} />
    </div>
  );
}
