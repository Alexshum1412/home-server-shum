import '@fontsource-variable/onest';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/pages.css';
import './styles/chat.css';
import './styles/cinema.css';
import { render } from 'preact';
import { App } from './app.tsx';
import { applyTheme } from './lib/theme.ts';
import { navigate } from './router.ts';

applyTheme();

const root = document.getElementById('app');
if (root) render(<App />, root);

// The service worker caches only the app shell; it needs a secure context (HTTPS or localhost).
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      console.warn('Service worker не зарегистрирован', error);
    });
  });
  // A click on a notification asks the open window to show the page it is about.
  navigator.serviceWorker.addEventListener(
    'message',
    (event: MessageEvent<{ type?: string; path?: string }>) => {
      const path = event.data?.path;
      if (
        event.data?.type === 'open' &&
        typeof path === 'string' &&
        path.startsWith('/') &&
        !path.startsWith('//')
      ) {
        navigate(path);
      }
    },
  );
}
