import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { chooseWithModel } from '../src/olivia/assistant/model.ts';
import { llamaHeaders, readLlamaKey } from '../src/olivia/llm-key.ts';
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
  // Everything the supervisor writes (the access keys of the programs) stays inside the throwaway folder.
  const all = { DASHBOARD_DATA_DIR: path.join(dir, 'data'), ...env, ...extra };
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
    const config = loadConfig({ DASHBOARD_DATA_DIR: path.join(dir, 'data'), ...env });
    const paths = llamaPaths(env, config);
    expect(paths.port).toBe(8099);
    const args = llamaArgs(paths, config, { OLIVIA_LLM_THREADS: '99', OLIVIA_LLM_CONTEXT: '10' });
    expect(args.slice(args.indexOf('--host'), args.indexOf('--host') + 2)).toEqual(['--host', '127.0.0.1']);
    expect(args[args.indexOf('--alias') + 1]).toBe('tiny');
    expect(args[args.indexOf('-t') + 1]).toBe('16'); // clamped
    expect(args[args.indexOf('-c') + 1]).toBe('512'); // clamped
  });

  it('protects the model with an access key that the portal sends and nobody else knows', async () => {
    const home = path.join(dir, 'llama');
    const model = path.join(dir, 'model.gguf');
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'llama-server.exe'), '');
    await writeFile(model, '');
    const env = {
      DASHBOARD_DATA_DIR: path.join(dir, 'data'),
      LLAMA_HOME: home,
      OLIVIA_MODEL_FILE: model,
      OLIVIA_LLM_URL: 'http://127.0.0.1:8081/v1',
    };
    const config = loadConfig(env);
    const keyFile = config.oliviaLlm?.keyFile ?? '';
    expect(keyFile).toBe(path.join(dir, 'data', 'llama-api.key'));
    expect(readLlamaKey(keyFile)).toBeNull(); // not made until the supervisor builds the list

    const spec = buildAppSpecs({
      config,
      env,
      nodeExe: process.execPath,
      logDir: path.join(dir, 'log'),
    }).find((item) => item.name === 'llama');
    expect(spec?.lowPriority).toBe(true); // below normal: film and portal come first
    expect(spec?.args).toContain('--api-key-file');
    expect(spec?.args[(spec?.args.indexOf('--api-key-file') ?? 0) + 1]).toBe(keyFile);
    const key = readLlamaKey(keyFile);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Asking again keeps the same key (a restart of the supervisor must not lock the portal out).
    buildAppSpecs({ config, env, nodeExe: process.execPath, logDir: path.join(dir, 'log') });
    expect(readLlamaKey(keyFile)).toBe(key);
    // The command line carries the name of the file, never the key itself.
    expect(spec?.args.join(' ')).not.toContain(key ?? 'x');

    expect(llamaHeaders(keyFile)).toEqual({
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    });
    expect(llamaHeaders(path.join(dir, 'nothing'))).toEqual({ 'content-type': 'application/json' });
    expect(llamaHeaders(undefined)).toEqual({ 'content-type': 'application/json' });
  });

  it('sends the key with the request that chooses a tool', async () => {
    const keyFile = path.join(dir, 'k.key');
    await writeFile(keyFile, `${'a'.repeat(64)}\n`);
    const seen: Array<string | null> = [];
    const llmFetch = async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('authorization'));
      const plan = { tool: 'disk', query: '', where: '', url: '', faqId: '' };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
    };
    const plan = await chooseWithModel(
      'сколько места осталось',
      { url: 'http://127.0.0.1:8081/v1', model: 'local', timeoutMs: 5000, keyFile },
      llmFetch,
    );
    expect(plan.tool).toBe('disk');
    expect(seen).toEqual([`Bearer ${'a'.repeat(64)}`]);
  });
});
