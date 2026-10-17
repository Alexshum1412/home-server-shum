import { promises as fsp } from 'node:fs';
import { buildApp } from './app.ts';
import { type Config, loadConfig } from './config.ts';
import { removeStaleTempFiles } from './files/cleanup.ts';
import { type LanListeners, listenOnLan } from './lan.ts';
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
  let lan: LanListeners | null = null;
  const shutdown = (reason: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`Сервер останавливается (${reason})…`);
    const force = setTimeout(() => {
      app.log.error('Сервер не остановился за 10 с, выход принудительно');
      process.exit(1);
    }, 10_000);
    force.unref();
    Promise.all([app.close(), lan?.close()]).then(
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

  // Optional fallback for a home without internet: also listen on the PC's own home-network address.
  if (config.lanBind.length > 0) {
    lan = await listenOnLan(app, config.lanBind, config.port);
    app.dashboard.lan.bound = lan.bound;
    app.dashboard.lan.failed = lan.failed;
    for (const address of lan.bound) {
      app.log.info(`Запасной адрес в домашней сети включён: http://${address}:${config.port}`);
    }
    for (const item of lan.failed) {
      app.log.warn(`Запасной адрес в домашней сети не включён (${item.address}): ${item.reason}`);
    }
  }

  // Half-written temp files from an earlier forced stop: cleaned in the background, never blocking start.
  void (async () => {
    for (const dir of [config.filesDir, config.photosDir]) {
      const removed = await removeStaleTempFiles(dir).catch(() => []);
      if (removed.length > 0) app.log.warn(`Удалены старые временные файлы в ${dir}: ${removed.length}`);
    }
  })();

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
