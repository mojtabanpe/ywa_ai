/* The episode brief: everything decided with the owner when picking the topic. The pipeline does the rest. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Shot {
  /** English video-model prompt; describe one continuous 9:16 shot. */
  prompt: string;
  /** Seconds of this shot used in the edit (Flow/Veo shots are 8 s). */
  seconds: number;
}

export interface Brief {
  episode: number;
  /** ASCII slug for files and the Drive name, e.g. "air-superiority". */
  slug: string;
  /** Persian title shown on the cover. */
  title: string;
  /** Short Persian line under the cover title, optional. */
  subtitle?: string;
  /** True for alternate-history fiction: adds the on-screen fiction label. */
  fictional: boolean;
  /** Full Persian narration, written for the ear (conversational Tehrani). */
  narration: string;
  shots: Shot[];
  /** Instagram caption body (without hashtags). */
  caption: string;
  hashtags: string[];
  /** Which moment of the clean edit to use as the cover background, in seconds. */
  coverAt: number;
  /** Optional source-video sound level under the narration, 0-1 (default 0.18). */
  shotAudioLevel?: number;
  /** Flow model: "veo-3.1-lite" (default, 10 credits per 8 s shot) or "omni-1.2-flash" (3 credits per second). */
  flowModel?: 'veo-3.1-lite' | 'omni-1.2-flash';
}

export const episodeDir = (slug: string) => join('episodes', slug);
export const outputDir = (slug: string) => join('output', 'episodes', slug);

export async function loadBrief(slug: string): Promise<Brief> {
  const brief = JSON.parse(await readFile(join(episodeDir(slug), 'brief.json'), 'utf8')) as Brief;
  const problems: string[] = [];
  if (!Number.isInteger(brief.episode) || brief.episode < 1) problems.push('episode must be a positive integer');
  if (!/^[a-z0-9-]+$/.test(brief.slug ?? '')) problems.push('slug must be lowercase ascii with dashes');
  if (brief.slug !== slug) problems.push(`slug "${brief.slug}" must match the folder name "${slug}"`);
  if (!brief.title?.trim()) problems.push('title is required');
  if (!brief.narration?.trim()) problems.push('narration is required');
  if (!Array.isArray(brief.shots) || brief.shots.length < 1) problems.push('at least one shot is required');
  brief.shots?.forEach((shot, index) => {
    if (!shot.prompt?.trim()) problems.push(`shot ${index + 1} needs a prompt`);
    if (!(shot.seconds > 0 && shot.seconds <= 8)) problems.push(`shot ${index + 1} seconds must be 1-8`);
  });
  if (!brief.caption?.trim()) problems.push('caption is required');
  if (!Array.isArray(brief.hashtags)) problems.push('hashtags must be a list');
  const total = brief.shots?.reduce((sum, shot) => sum + shot.seconds, 0) ?? 0;
  if (!(brief.coverAt >= 0 && brief.coverAt < total)) problems.push(`coverAt must be inside the edit (0-${total}s)`);
  if (problems.length) throw new Error(`brief.json is invalid:\n- ${problems.join('\n- ')}`);
  return brief;
}

export const totalSeconds = (brief: Brief) => brief.shots.reduce((sum, shot) => sum + shot.seconds, 0);
