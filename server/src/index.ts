import { promises as fsp } from 'node:fs';
import { buildApp } from './app.ts';
import { type Config, loadConfig } from './config.ts';
import { errorCode } from './lib/json-store.ts';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  await fsp.mkdir(config.dataDir, { recursive: true });

  const app = await buildApp({ config, startBackground: true });

  let closing = false;
  const shutdown = (reason: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`Сервер останавливается (${reason})…`);
    const force = setTimeout(() => {
      app.log.error('Сервер не остановился за 10 с, выход принудительно');
      process.exit(1);
    }, 10_000);
    force.unref();
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'Ошибка при остановке');
        process.exit(1);
      },
    );
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => shutdown(signal));
  }
  // Under the supervisor (server/src/supervisor) a clean stop arrives over IPC: Windows has no
  // SIGTERM, and killing the process would skip flushing sessions and the audit log.
  process.on('message', (message: unknown) => {
    if ((message as { type?: unknown } | null)?.type === 'shutdown') shutdown('команда супервизора');
  });
  process.on('disconnect', () => shutdown('отключение от супервизора'));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    if (errorCode(error) === 'EADDRINUSE') {
      app.log.error(
        `Порт ${config.port} на ${config.host} уже занят: возможно, семейный сервер уже запущен ` +
          'или порт использует другая программа. Остановите её или укажите другой порт в переменной PORT.',
      );
    } else {
      app.log.error({ err: error }, 'Не удалось запустить сервер');
    }
    await app.close().catch(() => undefined);
    process.exit(1);
  }

  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  app.log.info(
    `Семейный сервер запущен: http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${config.port} ` +
      `(данные: ${config.dataDir}${config.demo ? ', ДЕМО-РЕЖИМ' : ''})`,
  );
}

main().catch((error: unknown) => {
  console.error('Сервер не запустился:', error);
  process.exit(1);
});
