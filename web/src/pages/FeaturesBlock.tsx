import { useState } from 'preact/hooks';
import type { FeaturesResponse } from '../../../shared/features.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { useFeatures } from '../features.tsx';
import { useResource } from '../hooks/useResource.ts';

/** «Функции»: a switch for each function of the portal. Off means: hidden from the family and refused by the server. */
export function FeaturesBlock(props: { onResult: (ok: boolean, text: string) => void }) {
  const list = useResource<FeaturesResponse>('/api/features');
  const shared = useFeatures();
  const [busy, setBusy] = useState<string | null>(null);

  async function change(id: string, title: string, enabled: boolean) {
    setBusy(id);
    try {
      await apiPost<FeaturesResponse>('/api/admin/features', { id, enabled });
      list.reload();
      shared.reload();
      props.onResult(true, `«${title}»: ${enabled ? 'включена' : 'выключена'}.`);
    } catch (error) {
      const failure = toFailure(error);
      props.onResult(false, failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section class="page-section" aria-labelledby="features-title">
      <h2 id="features-title" class="section-title">
        Функции
      </h2>
      <p class="section-lead">
        Выключенная функция исчезает из меню у всей семьи, а сервер отказывает её запросам. Данные при этом не
        удаляются. Администрирование и эти переключатели выключить нельзя.
      </p>
      <ul class="features">
        {(list.data?.features ?? []).map((feature) => (
          <li key={feature.id} class="features__item">
            <label class="check">
              <input
                type="checkbox"
                checked={feature.enabled}
                disabled={busy !== null}
                onChange={(event) => void change(feature.id, feature.title, event.currentTarget.checked)}
              />
              <span>
                <strong>{feature.title}</strong>
                <span class="meta"> — {feature.lead}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
