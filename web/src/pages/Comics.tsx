import { BookOpen } from 'lucide-preact';
import { PageHeader } from '../components/PageHeader.tsx';

/** «Комиксы и манга»: where the reader (Kavita) is and how to start. The administrator switches this page on. */
export function ComicsPage() {
  const address = `${location.protocol}//${location.hostname}:5000`;
  return (
    <div class="page page--narrow">
      <PageHeader
        title="Комиксы, манга и книги"
        icon={BookOpen}
        lead="Читалка Kavita работает на этом же компьютере: комиксы, манга и книги с закладками и продолжением с того места, где остановились."
      />
      <section class="page-section">
        <h2 class="section-title">Открыть читалку</h2>
        <p>
          <a class="button button--primary" href={address} target="_blank" rel="noopener noreferrer">
            Открыть Kavita
          </a>
        </p>
        <p class="meta">
          Читалка открывается по адресу {address} (в домашней сети). У неё свои учётные записи: при первом
          открытии администратор создаёт первую запись и добавляет библиотеку — папку «Комиксы и манга» на
          диске D (файлы cbz, cbr, pdf, epub).
        </p>
      </section>
    </div>
  );
}
