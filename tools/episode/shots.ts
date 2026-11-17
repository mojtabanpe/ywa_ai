/* Shot generation with the owner's provider order: Flow (both usable accounts) → Veo API → Higgsfield API.
 * A shot file already on disk is kept, so a rerun only makes what is missing. */
import axios from 'axios';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { shotFile } from './assemble';
import { Brief, Shot } from './brief';
import { flowShot } from './flow';
import { ensureDir, env, firstSuccess, http, log, probe, requireEnv, sleep } from './lib';

async function download(url: string, file: string) {
  const { data } = await axios.get(url, { ...http(), responseType: 'arraybuffer' });
  await writeFile(file, Buffer.from(data));
}

/** Veo through the Gemini API (paid; needs billing on the key's Cloud project). */
async function veoShot(shot: Shot, file: string) {
  const base = env('GEMINI_API_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta';
  const model = env('VEO_MODEL') || 'veo-3.1-fast-generate-preview';
  const headers = { 'x-goog-api-key': requireEnv('GEMINI_API_KEY') };
  const { data: operation } = await axios.post(
    `${base}/models/${model}:predictLongRunning`,
    { instances: [{ prompt: shot.prompt }], parameters: { aspectRatio: '9:16', durationSeconds: 8 } },
    { ...http(), headers },
  );
  for (let i = 0; i < 60; i++) {
    await sleep(10_000);
    const { data } = await axios.get(`${base}/${operation.name}`, { ...http(), headers });
    if (data.error) throw new Error(`Veo: ${JSON.stringify(data.error).slice(0, 300)}`);
    if (data.done) {
      const uri = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new Error(`Veo finished without a video: ${JSON.stringify(data.response).slice(0, 300)}`);
      const { data: video } = await axios.get(uri, { ...http(), headers, responseType: 'arraybuffer' });
      await writeFile(file, Buffer.from(video));
      return;
    }
  }
  throw new Error('Veo timed out after 10 minutes');
}

/** Higgsfield REST API (funded account). Model and path are configurable; default Seedance 2.0 text-to-video. */
async function higgsfieldShot(shot: Shot, file: string) {
  const auth = { Authorization: `Key ${requireEnv('HIGGSFIELD_API_KEY')}:${requireEnv('HIGGSFIELD_API_SECRET')}` };
  const path = env('HIGGSFIELD_VIDEO_PATH') || '/bytedance/seedance-2.0/text-to-video';
  const { data: job } = await axios.post(
    `https://api.higgsfield.ai${path}`,
    { prompt: shot.prompt, duration: Math.max(4, Math.ceil(shot.seconds)), resolution: '720p', aspect_ratio: '9:16', generate_audio: true },
    { ...http(), headers: auth },
  );
  for (let i = 0; i < 90; i++) {
    await sleep(10_000);
    const { data } = await axios.get(job.status_url ?? `https://api.higgsfield.ai/requests/${job.request_id}/status`, { ...http(), headers: auth });
    if (data.status === 'completed') return download(data.video?.url, file);
    if (['failed', 'nsfw', 'canceled'].includes(data.status)) throw new Error(`Higgsfield job ${data.status}`);
  }
  throw new Error('Higgsfield timed out after 15 minutes');
}

/** Flow accounts in use order: /u/1 holds most credits, /u/0 is the backup. The third account has no Flow access. */
const FLOW_ACCOUNTS = (env('FLOW_ACCOUNTS') || '1,0').split(',').map(Number);

export async function makeShots(brief: Brief) {
  const used: Array<{ shot: number; provider: string }> = [];
  const only = env('SHOT_PROVIDER');
  for (const [index, shot] of brief.shots.entries()) {
    const file = shotFile(brief.slug, index);
    if (existsSync(file)) {
      await log(`shot ${index + 1}: already on disk, kept`);
      used.push({ shot: index + 1, provider: 'existing' });
      continue;
    }
    await ensureDir(file);
    const candidates = [
      ...FLOW_ACCOUNTS.map((account) => ({ name: `flow-u${account}`, attempt: () => flowShot(brief, index, shot, file, account) })),
      { name: 'veo-api', attempt: () => veoShot(shot, file) },
      { name: 'higgsfield-api', attempt: () => higgsfieldShot(shot, file) },
    ].filter((candidate) => !only || candidate.name.startsWith(only));
    const { name } = await firstSuccess(`shot ${index + 1}`, candidates.map((candidate) => ({
      ...candidate,
      attempt: async () => {
        await candidate.attempt();
        const info = probe(file);
        if (info.duration < shot.seconds - 0.5 || info.height <= info.width) throw new Error(`unusable shot: ${info.width}×${info.height}, ${info.duration.toFixed(1)} s`);
      },
    })));
    used.push({ shot: index + 1, provider: name });
  }
  return used;
}
