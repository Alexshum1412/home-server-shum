import { Power } from 'lucide-preact';
import { EmptyState } from '../components/EmptyState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';

/** A page of a function that the administrator switched off. */
export function FeatureOffPage() {
  return (
    <div class="page">
      <PageHeader title="Функция отключена" icon={Power} />
      <EmptyState icon={Power} title="Администратор отключил эту функцию">
        <p>Она появится снова, когда администратор её включит (раздел «Администрирование» → «Функции»).</p>
      </EmptyState>
    </div>
  );
}
