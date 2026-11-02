import { Printer, ShieldAlert } from 'lucide-preact';
import { useEffect, useId, useState } from 'preact/hooks';
import { apiGet, apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { formatDateTime } from '../lib/format.ts';

interface Card {
  text: string;
  updatedAt: string | null;
  updatedBy: string | null;
  canEdit: boolean;
}

const KEY = 'fs-emergency-card-v1';

function parse(text: string): Array<{ title: string; lines: string[] }> {
  const out: Array<{ title: string; lines: string[] }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('# ')) out.push({ title: line.slice(2), lines: [] });
    else if (line !== '')
      (out[out.length - 1] ?? out[out.push({ title: '', lines: [] }) - 1])?.lines.push(line);
  }
  return out;
}

/** «Экстренная карточка»: what the family needs in trouble; opens without the internet and prints on paper. */
export function EmergencyPage() {
  const ids = useId();
  const toast = useToast();
  const [card, setCard] = useState<Card | null>(null);
  const [offline, setOffline] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<Card>('/api/emergency').then(
      (loaded) => {
        setCard(loaded);
        try {
          localStorage.setItem(KEY, JSON.stringify(loaded));
        } catch {
          // storage may be blocked
        }
      },
      () => {
        try {
          const saved = localStorage.getItem(KEY);
          if (saved) {
            setCard({ ...(JSON.parse(saved) as Card), canEdit: false });
            setOffline(true);
          }
        } catch {
          // nothing saved
        }
      },
    );
  }, []);

  async function save() {
    setBusy(true);
    try {
      const saved = await apiPost<Card>('/api/emergency', { text: draft });
      setCard(saved);
      setEditing(false);
      try {
        localStorage.setItem(KEY, JSON.stringify(saved));
      } catch {
        // storage may be blocked
      }
      toast.showOk('Карточка сохранена.');
    } catch (error) {
      const failure = toFailure(error);
      toast.showError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="page page--narrow emergency">
      <PageHeader
        title="Экстренная карточка"
        icon={ShieldAlert}
        lead="Телефоны, где лежат документы, что взять с собой и где встречаться, если нет связи. Карточка открывается и без интернета (телефон хранит последнюю копию), и её можно распечатать и положить рядом с документами."
      />
      {!card ? <Loading label="Загружаем…" /> : null}
      {card ? (
        <>
          {offline ? (
            <p class="banner banner--warn" role="status">
              Сервер не отвечает: показана копия, сохранённая на этом устройстве.
            </p>
          ) : null}
          {editing ? (
            <section class="page-section">
              <label class="field__label" htmlFor={`${ids}-text`}>
                Текст карточки. Строка «# Заголовок» начинает раздел, остальные строки — его содержимое.
              </label>
              <textarea
                id={`${ids}-text`}
                class="field__input"
                rows={22}
                value={draft}
                maxLength={20000}
                onInput={(e) => setDraft(e.currentTarget.value)}
              />
              <div class="action-row">
                <button
                  type="button"
                  class="button button--primary"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  Сохранить
                </button>
                <button type="button" class="button button--quiet" onClick={() => setEditing(false)}>
                  Отмена
                </button>
              </div>
            </section>
          ) : (
            <>
              {parse(card.text).map((section) => (
                <section key={section.title} class="page-section emergency__section">
                  {section.title ? <h2 class="section-title">{section.title}</h2> : null}
                  {section.lines.map((line) => (
                    <p key={line} class="emergency__line">
                      {line}
                    </p>
                  ))}
                </section>
              ))}
              <p class="meta">
                {card.updatedAt
                  ? `Обновлено ${formatDateTime(card.updatedAt)}${card.updatedBy ? `, ${card.updatedBy}` : ''}.`
                  : 'Это заготовка: администратор впишет наши данные.'}
              </p>
              <div class="action-row emergency__actions">
                <button type="button" class="button button--secondary" onClick={() => window.print()}>
                  <Printer size={18} aria-hidden="true" />
                  Распечатать
                </button>
                {card.canEdit ? (
                  <button
                    type="button"
                    class="button button--primary"
                    onClick={() => {
                      setDraft(card.text);
                      setEditing(true);
                    }}
                  >
                    Изменить
                  </button>
                ) : null}
              </div>
            </>
          )}
        </>
      ) : null}
      <ToastRegion toast={toast} />
    </div>
  );
}
