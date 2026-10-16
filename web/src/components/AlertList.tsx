import type { Alert } from '../../../shared/api.ts';
import { ALERT_LEVEL, sortAlerts } from '../lib/labels.ts';
import { STATUS_ICONS } from './icons.ts';

/** Confirmed problems from real checks, most important first, in plain language. */
export function AlertList(props: { alerts: readonly Alert[] }) {
  if (props.alerts.length === 0) return null;
  return (
    <section class="alerts" aria-label="Важные сообщения">
      <ul class="alerts__list">
        {sortAlerts(props.alerts).map((alert) => {
          const level = ALERT_LEVEL[alert.level];
          const Icon = STATUS_ICONS[level.icon];
          return (
            <li key={alert.id} class={`alert alert--${level.tone}`}>
              <Icon class="alert__icon" size={20} aria-hidden="true" />
              <div class="alert__body">
                <p class="alert__title">
                  <span class="visually-hidden">{level.label}: </span>
                  {alert.title}
                </p>
                <p class="alert__text">{alert.text}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
