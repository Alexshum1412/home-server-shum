/**
 * The tab title: «(3) Чат — Семейный сервер». The page sets its name, the chat adds the number of
 * unread messages, and neither overwrites the other.
 */
let base = '';
let unread = 0;

function apply(): void {
  document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${base}` : base;
}

export function setPageTitle(title: string): void {
  base = title;
  apply();
}

export function setUnreadInTitle(count: number): void {
  unread = count;
  apply();
}
