import '@fontsource-variable/onest';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/pages.css';
import { render } from 'preact';
import { App } from './app.tsx';

const root = document.getElementById('app');
if (root) render(<App />, root);

// The service worker caches only the app shell; it needs a secure context (HTTPS or localhost).
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      console.warn('Service worker не зарегистрирован', error);
    });
  });
}
