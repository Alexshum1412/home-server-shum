/**
 * Look of the portal: light (default), dark, or «as the device». The choice is kept on the device
 * (localStorage) and applied as <html data-theme>; tokens.css does the rest.
 */
export type Theme = 'light' | 'dark' | 'system';

export const THEME_LABEL: Record<Theme, string> = {
  light: 'Светлое',
  dark: 'Тёмное',
  system: 'Как на устройстве',
};

const KEY = 'family-theme';
const BAR_COLOR = { light: '#f7f9fc', dark: '#0f1620' } as const;

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'dark' || value === 'system' ? value : 'light';
  } catch {
    return 'light';
  }
}

function isDark(theme: Theme): boolean {
  return (
    theme === 'dark' || (theme === 'system' && matchMedia?.('(prefers-color-scheme: dark)').matches === true)
  );
}

/** Puts the theme on the page and tells the browser which colour its own bar should have. */
export function applyTheme(theme: Theme = readTheme()): void {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = isDark(theme) ? BAR_COLOR.dark : BAR_COLOR.light;
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // private mode: the choice lasts until the page is closed
  }
  applyTheme(theme);
}
