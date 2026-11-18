/* Shared helpers for the episode pipeline: environment, proxy, process runners, media probing, logging. */
import axios, { AxiosProxyConfig } from 'axios';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

export const env = (name: string) => {
  const value = process.env[name]?.trim();
  return value && !value.startsWith('replace-with') ? value : undefined;
};

export function requireEnv(name: string) {
  const value = env(name);
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

/** googleapis.com, Higgsfield and ElevenLabs are not reachable directly from this Mac; everything goes through the local xray proxy. */
export function proxyUrl() {
  return env('PIPELINE_PROXY_URL') || env('GEMINI_PROXY_URL') || 'http://127.0.0.1:7890';
}

export function axiosProxy(): AxiosProxyConfig {
  const url = new URL(proxyUrl());
  return { protocol: url.protocol.replace(':', ''), host: url.hostname, port: Number(url.port) };
}

export const http = () => ({ proxy: axiosProxy(), timeout: 180_000, maxBodyLength: Infinity, maxContentLength: Infinity });

export function describeError(error: unknown) {
  if (!axios.isAxiosError(error)) return error instanceof Error ? error.message : String(error);
  const data = error.response?.data;
  const body = Buffer.isBuffer(data) || data instanceof ArrayBuffer ? Buffer.from(data as ArrayBuffer).toString() : typeof data === 'string' ? data : JSON.stringify(data ?? error.message);
  return `HTTP ${error.response?.status ?? error.code ?? '-'} ${body.slice(0, 300)}`;
}

export function run(command: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: options.input, env: options.env ?? process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')}… failed: ${(result.stderr || result.stdout || '').slice(-1500)}`);
  return result.stdout;
}

export const ffmpeg = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

export function probe(file: string) {
  const out = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height', '-of', 'json', file]);
  const data = JSON.parse(out) as {
    format: { duration?: string; format_name?: string };
    streams: Array<{ codec_type: string; codec_name?: string; width?: number; height?: number }>;
  };
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  const duration = Number(data.format.duration);
  return {
    duration,
    /** A still image (JPEG/PNG/WebP) also probes as one "video" stream, but with no finite duration. */
    isVideo: Boolean(video) && Number.isFinite(duration) && duration > 0 && !/^(mjpeg|png|webp|bmp|gif)$/.test(video?.codec_name ?? '') && !/image2|_pipe$/.test(data.format.format_name ?? ''),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: data.streams.some((stream) => stream.codec_type === 'audio'),
  };
}

export async function ensureDir(file: string) {
  await mkdir(dirname(file), { recursive: true });
}

let logFile: string | undefined;
export function setLogFile(file: string) {
  logFile = file;
}

export async function log(message: string) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
  console.log(line);
  if (logFile) await appendFile(logFile, line + '\n');
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tries each candidate in order and returns the first success; logs every failure so the run explains its fallbacks. */
export async function firstSuccess<T>(label: string, candidates: Array<{ name: string; attempt: () => Promise<T> }>) {
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      await log(`${label}: trying ${candidate.name}`);
      const result = await candidate.attempt();
      await log(`${label}: ${candidate.name} succeeded`);
      return { name: candidate.name, result };
    } catch (error) {
      const reason = describeError(error);
      failures.push(`${candidate.name}: ${reason}`);
      await log(`${label}: ${candidate.name} failed: ${reason}`);
    }
  }
  throw new Error(`${label}: every provider failed\n${failures.join('\n')}`);
}

/**
 * The Chrome the pipeline drives: the dedicated automation Chrome (tools/automation-chrome.sh, port 9223, no
 * "allow" prompt), started on demand. CHROME_CDP overrides it, e.g. ws://127.0.0.1:9222/devtools/browser for the
 * everyday Chrome with the chrome://inspect toggle.
 */
export async function chromeEndpoint() {
  const override = env('CHROME_CDP') || env('CHROME_CDP_WS');
  if (override) return override;
  const port = env('YWA_CHROME_PORT') || '9223';
  const url = `http://127.0.0.1:${port}`;
  const up = async () => {
    try {
      const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  };
  if (!(await up())) {
    await log('chrome: starting the automation Chrome (tools/automation-chrome.sh)');
    run('zsh', ['tools/automation-chrome.sh']);
  }
  return url;
}
