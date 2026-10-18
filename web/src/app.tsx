import { RefreshCw, WifiOff } from 'lucide-preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SessionResponse } from '../../shared/api.ts';
import { type ApiFailure, apiGet, apiPost, NO_CONNECTION, onUnauthorized, toFailure } from './api.ts';
import { CallOverlay } from './calls/CallOverlay.tsx';
import { CallProvider } from './calls/CallProvider.tsx';
import { ChatProvider } from './chat/ChatProvider.tsx';
import { AppShell } from './components/AppShell.tsx';
import { documentTitle, type RouteId } from './lib/routes.ts';
import { setPageTitle } from './lib/title.ts';
import { AccountPage } from './pages/Account.tsx';
import { AdminPage } from './pages/Admin.tsx';
import { CalendarPage } from './pages/Calendar.tsx';
import { ChatPage } from './pages/Chat.tsx';
import { CinemaPage } from './pages/Cinema.tsx';
import { DownloadsPage } from './pages/Downloads.tsx';
import { FilesPage } from './pages/Files.tsx';
import { ForcedPasswordPage } from './pages/ForcedPassword.tsx';
import { HelpPage } from './pages/Help.tsx';
import { HomePage } from './pages/Home.tsx';
import { LoginPage } from './pages/Login.tsx';
import { NotesPage } from './pages/Notes.tsx';
import { NotFoundPage } from './pages/NotFound.tsx';
import { NotificationsPage } from './pages/Notifications.tsx';
import { OliviaPage } from './pages/Olivia.tsx';
import { PhotosPage } from './pages/Photos.tsx';
import { PrintPage } from './pages/Print.tsx';
import { SystemPage } from './pages/System.tsx';
import { navigate, startRouter, useLocation } from './router.ts';
import { DataProvider, SessionProvider } from './state.tsx';

type Boot =
  | { status: 'loading' }
  | { status: 'anon' }
  | { status: 'authed'; session: SessionResponse }
  | { status: 'error'; failure: ApiFailure };

function Page(props: { route: RouteId; onSessionChanged: (session: SessionResponse) => void }) {
  switch (props.route) {
    case 'home':
      return <HomePage />;
    case 'cinema':
      return <CinemaPage />;
    case 'chat':
      return <ChatPage />;
    case 'notifications':
      return <NotificationsPage />;
    case 'olivia':
      return <OliviaPage />;
    case 'photos':
      return <PhotosPage />;
    case 'files':
      return <FilesPage />;
    case 'downloads':
      return <DownloadsPage />;
    case 'calendar':
      return <CalendarPage />;
    case 'notes':
      return <NotesPage />;
    case 'print':
      return <PrintPage />;
    case 'system':
      return <SystemPage />;
    case 'help':
      return <HelpPage />;
    case 'admin':
      return <AdminPage />;
    case 'account':
      return <AccountPage onSessionChanged={props.onSessionChanged} />;
    case 'login':
      return null;
    default:
      return <NotFoundPage />;
  }
}

function BootScreen() {
  return (
    <main id="main" class="boot" aria-busy="true">
      <img class="boot__mark" src="/icons/icon.svg" alt="" width={56} height={56} />
      <h1 class="boot__title">Семейный сервер</h1>
      <p class="boot__text">Подключаемся к домашнему серверу…</p>
    </main>
  );
}

function BootError(props: { failure: ApiFailure; onRetry: () => void }) {
  const { failure } = props;
  return (
    <main id="main" class="boot">
      <WifiOff class="boot__icon" size={40} aria-hidden="true" />
      <h1 class="boot__title" tabIndex={-1}>
        {failure.unreachable ? NO_CONNECTION : 'Портал не смог загрузиться'}
      </h1>
      <p class="boot__text">
        {failure.unreachable
          ? 'Проверьте, что на этом устройстве включён Tailscale, а домашний компьютер включён и подключён к интернету.'
          : failure.message}
      </p>
      <button type="button" class="button button--primary button--large" onClick={props.onRetry}>
        <RefreshCw size={20} aria-hidden="true" />
        Повторить
      </button>
    </main>
  );
}

export function App() {
  const { path, route } = useLocation();
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    setBoot({ status: 'loading' });
    try {
      const session = await apiGet<SessionResponse>('/api/session', { quiet401: true });
      setBoot({ status: 'authed', session });
    } catch (error) {
      const failure = toFailure(error);
      setBoot(failure.status === 401 ? { status: 'anon' } : { status: 'error', failure });
    }
  }, []);

  useEffect(() => startRouter(), []);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);
  useEffect(() => onUnauthorized(() => setBoot({ status: 'anon' })), []);

  const logout = useCallback(async () => {
    try {
      await apiPost('/api/logout', {}, { quiet401: true });
    } catch (error) {
      const failure = toFailure(error);
      // A 401 means the session is already gone; anything else keeps the user signed in.
      if (failure.status !== 401) {
        setNotice(
          `Выйти не получилось: ${failure.unreachable ? NO_CONNECTION.toLowerCase() : failure.message}`,
        );
        return;
      }
    }
    setNotice(null);
    setBoot({ status: 'anon' });
    navigate('/', { replace: true });
  }, []);

  const signedIn = boot.status === 'authed';
  const effectiveRoute: RouteId = boot.status === 'anon' ? 'login' : route;

  // Signed-in users have nothing to do on /login.
  useEffect(() => {
    if (signedIn && route === 'login') navigate('/', { replace: true });
  }, [signedIn, route]);

  useEffect(() => {
    setPageTitle(documentTitle(effectiveRoute));
  }, [effectiveRoute]);

  // Move focus to the page heading after every navigation (not on the first load),
  // so screen readers announce the new page. `path` is the trigger, not an input.
  const focusArmed = useRef(false);
  useEffect(() => {
    if (boot.status === 'loading') return;
    if (!focusArmed.current) {
      focusArmed.current = true;
      return;
    }
    document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true });
  }, [path, boot.status]);

  const sessionValue = useMemo(
    () => (boot.status === 'authed' ? { session: boot.session, logout } : null),
    [boot, logout],
  );

  if (boot.status === 'loading') return <BootScreen />;
  if (boot.status === 'error') return <BootError failure={boot.failure} onRetry={loadSession} />;
  if (boot.status === 'anon' || !sessionValue) {
    return <LoginPage onSignedIn={(session) => setBoot({ status: 'authed', session })} />;
  }
  if (boot.status === 'authed' && boot.session.mustChangePassword) {
    // A generated first-sign-in password: nothing else works until the user picks an own one.
    return (
      <ForcedPasswordPage
        session={boot.session}
        onChanged={(session) => setBoot({ status: 'authed', session })}
        onLogout={() => void logout()}
      />
    );
  }
  return (
    <SessionProvider value={sessionValue}>
      <DataProvider>
        <ChatProvider>
          <CallProvider>
            <AppShell path={path} notice={notice}>
              <Page route={route} onSessionChanged={(session) => setBoot({ status: 'authed', session })} />
            </AppShell>
            <CallOverlay />
          </CallProvider>
        </ChatProvider>
      </DataProvider>
    </SessionProvider>
  );
}
