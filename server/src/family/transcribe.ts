/**
 * Voice recordings of the family archive into text (whisper.cpp on this PC, the «small» model, Russian by default). The
 * recording is first made into a 16 kHz wav with the ffmpeg that comes with Jellyfin, then read by whisper-cli; both are
 * started with fixed arguments and a temporary file name made here. It is slow on this processor (about as long as the
 * recording itself), so it runs one at a time in the background and only when the administrator switched it on.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface TranscribePaths {
  ffmpeg: string;
  whisper: string;
  model: string;
}

export function transcribePaths(env: NodeJS.ProcessEnv): TranscribePaths {
  const drive = /^[A-Za-z]:$/.test(env.SystemDrive ?? '') ? (env.SystemDrive as string) : 'C:';
  const root = `${drive}\\FamilyServer`;
  return {
    ffmpeg: env.FFMPEG_EXE?.trim() || `${root}\\apps\\jellyfin\\ffmpeg.exe`,
    whisper: env.WHISPER_EXE?.trim() || `${root}\\apps\\whisper\\Release\\whisper-cli.exe`,
    model: env.WHISPER_MODEL?.trim() || `${root}\\data\\models\\ggml-small.bin`,
  };
}

function run(exe: string, args: string[], ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      args,
      { timeout: ms, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.on('error', reject);
  });
}

export function createTranscriber(paths: TranscribePaths) {
  const available = () => existsSync(paths.ffmpeg) && existsSync(paths.whisper) && existsSync(paths.model);
  let chain: Promise<unknown> = Promise.resolve();
  return {
    available,
    /** Text of a recording, or null. One at a time: the processor is shared with everything else. */
    transcribe(file: string, language = 'ru'): Promise<string | null> {
      const job = chain.then(async () => {
        if (!available()) return null;
        const dir = await mkdtemp(path.join(os.tmpdir(), 'stt-'));
        try {
          const wav = path.join(dir, 'voice.wav');
          await run(
            paths.ffmpeg,
            ['-y', '-i', file, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
            120_000,
          );
          const out = await run(
            paths.whisper,
            [
              '-m',
              paths.model,
              '-f',
              wav,
              '-l',
              /^[a-z]{2}$/.test(language) ? language : 'ru',
              '-nt',
              '-np',
              '-t',
              '2',
            ],
            3_600_000,
          );
          const text = out.replace(/\s+/g, ' ').trim();
          return text.length >= 2 ? text.slice(0, 20_000) : null;
        } catch {
          return null;
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
      chain = job.catch(() => undefined);
      return job;
    },
  };
}

export type Transcriber = ReturnType<typeof createTranscriber>;
