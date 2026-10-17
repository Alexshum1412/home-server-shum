import { useId, useState } from 'preact/hooks';
import type { Alert } from '../../../shared/api.ts';
import { ALERT_LEVEL, sortAlerts } from '../lib/labels.ts';
import { STATUS_ICONS } from './icons.ts';

/** Texts longer than this get collapsed to two lines on phones (compact lists only). */
const CLAMP_FROM_CHARS = 110;

/**
 * The last sentence of an alert is the next step («Не форматируйте…», «Сообщите администратору»).
 * It is never collapsed: a clamp must not cut off exactly the part that says what to do.
 */
export function splitNextStep(text: string): { lead: string; step: string } {
  const sentences = text.split(/(?<=[.!?…])s+/).filter((part) => part.trim() !== '');
  if (sentences.length < 2) return { lead: text, step: '' };
  return { lead: sentences.slice(0, -1).join(' '), step: sentences[sentences.length - 1] ?? '' };
}

function AlertItem(props: { alert: Alert; compact: boolean }) {
  const { alert } = props;
  const level = ALERT_LEVEL[alert.level];
  const Icon = STATUS_ICONS[level.icon];
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  // Critical alerts are always shown in full; only long warnings/info may be collapsed.
  const clampable = props.compact && alert.level !== 'critical' && alert.text.length > CLAMP_FROM_CHARS;
  const { lead, step } = clampable ? splitNextStep(alert.text) : { lead: alert.text, step: '' };
  const classes = ['alert', `alert--${level.tone}`];
  if (clampable) classes.push('alert--clampable');
  if (clampable && expanded) classes.push('alert--expanded');
  return (
    <li class={classes.join(' ')}>
      <Icon class="alert__icon" size={20} aria-hidden="true" />
      <div class="alert__body">
        <p class="alert__title">
          <span class="visually-hidden">{level.label}: </span>
          {alert.title}
        </p>
        <p class="alert__text" id={textId}>
          {lead}
        </p>
        {clampable ? (
          <button
            type="button"
            class="alert__more"
            aria-expanded={expanded ? 'true' : 'false'}
            aria-controls={textId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Свернуть' : 'Подробнее'}
          </button>
        ) : null}
        {step ? <p class="alert__step">{step}</p> : null}
      </div>
    </li>
  );
}

/**
 * Confirmed problems from real checks, most important first, in plain language.
 * `compact` (home page): on phones long non-critical texts are collapsed to two lines with a
 * «Подробнее» button, so the cinema stays near the top; the full text stays in the page.
 */
export function AlertList(props: { alerts: readonly Alert[]; compact?: boolean }) {
  if (props.alerts.length === 0) return null;
  return (
    <section class="alerts" aria-label="Важные сообщения">
      <ul class="alerts__list">
        {sortAlerts(props.alerts).map((alert) => (
          <AlertItem key={alert.id} alert={alert} compact={props.compact === true} />
        ))}
      </ul>
    </section>
  );
}
