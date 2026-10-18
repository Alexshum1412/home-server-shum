import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { buildAppSpecs, llamaArgs, llamaPaths } from '../src/supervisor/apps.ts';
import { makeTempDir, removeDir } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('fd-apps-');
});
afterEach(async () => {
  await removeDir(dir);
});

const names = (env: Record<string, string>, extra: Record<string, string> = {}) => {
  const all = { DATA_DIR: path.join(dir, 'data'), ...env, ...extra };
  const config = loadConfig(all);
  return buildAppSpecs({ config, env: all, nodeExe: process.execPath, logDir: path.join(dir, 'log') }).map(
    (spec) => spec.name,
  );
};

describe('the language model of Olivia in the supervisor', () => {
  it('is started only when it is installed and switched on', async () => {
    const home = path.join(dir, 'llama');
    const model = path.join(dir, 'model.gguf');
    const env = { LLAMA_HOME: home, OLIVIA_MODEL_FILE: model, OLIVIA_LLM_URL: 'http://127.0.0.1:8081/v1' };
    expect(names(env)).not.toContain('llama'); // nothing installed

    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'llama-server.exe'), '');
    expect(names(env)).not.toContain('llama'); // no model file yet

    await writeFile(model, '');
    expect(names(env)).toContain('llama');
    expect(names({ ...env, SUPERVISE_LLAMA: '0' })).not.toContain('llama'); // switched off by hand
    expect(names({ ...env, OLIVIA_LLM_URL: '' })).not.toContain('llama'); // the portal does not use a model
  });

  it('listens on this PC only and keeps to the port of OLIVIA_LLM_URL', () => {
    const env = { OLIVIA_LLM_URL: 'http://127.0.0.1:8099/v1', OLIVIA_LLM_MODEL: 'tiny' };
    const config = loadConfig({ DATA_DIR: path.join(dir, 'data'), ...env });
    const paths = llamaPaths(env, config);
    expect(paths.port).toBe(8099);
    const args = llamaArgs(paths, config, { OLIVIA_LLM_THREADS: '99', OLIVIA_LLM_CONTEXT: '10' });
    expect(args.slice(args.indexOf('--host'), args.indexOf('--host') + 2)).toEqual(['--host', '127.0.0.1']);
    expect(args[args.indexOf('--alias') + 1]).toBe('tiny');
    expect(args[args.indexOf('-t') + 1]).toBe('16'); // clamped
    expect(args[args.indexOf('-c') + 1]).toBe('512'); // clamped
  });
});
