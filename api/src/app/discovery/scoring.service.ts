import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { resolveLlmConfig } from '../llm/llm.config';

export interface TopicScoreInput {
  viralScore: number;
  noveltyScore: number;
  usefulnessScore: number;
  persianAudienceScore: number;
  visualScore: number;
  totalScore: number;
  reason: string;
}

@Injectable()
export class TopicScoringService {
  private readonly logger = new Logger(TopicScoringService.name);
  private unavailableUntil = 0;

  async score(title: string, description: string): Promise<TopicScoreInput> {
    const fallback = deterministicScore(title, description);
    const llm = resolveLlmConfig();
    if (!llm.baseURL || !llm.apiKey || Date.now() < this.unavailableUntil) return fallback;

    try {
      const response = await axios.post(
        `${llm.baseURL.replace(/\/$/, '')}/chat/completions`,
        {
          model: llm.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You rank AI-news ideas for short Persian Instagram Reels. Return only valid JSON with integer viralScore, noveltyScore, usefulnessScore, persianAudienceScore, visualScore (each 0-100), and a concise Persian reason. Prioritize useful, visually demonstrable, timely topics. Do not invent facts.',
            },
            {
              role: 'user',
              content: `Title: ${title}\nDescription: ${description || '(none)'}`,
            },
          ],
        },
        {
          headers: { Authorization: `Bearer ${llm.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 10_000,
        },
      );
      const content = extractContent(response.data);
      const parsed = typeof content === 'string' ? JSON.parse(stripCodeFence(content)) : content;
      const score = validateScore(parsed);
      return { ...score, totalScore: average(score) };
    } catch (error) {
      this.logger.warn(`LLM scoring failed; using deterministic fallback. ${error instanceof Error ? error.message : 'Unknown error'}`);
      this.unavailableUntil = Date.now() + 5 * 60_000;
      return fallback;
    }
  }
}

function stripCodeFence(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function extractContent(payload: unknown): unknown {
  if (typeof payload !== 'string') {
    return (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  }
  const dataLine = payload.split('\n').find((line) => line.startsWith('data: ') && !line.includes('[DONE]'));
  if (!dataLine) throw new Error('LLM response did not contain a completion event');
  return JSON.parse(dataLine.slice(6)).choices?.[0]?.message?.content;
}

function validateScore(value: unknown): Omit<TopicScoreInput, 'totalScore'> {
  if (!value || typeof value !== 'object') throw new Error('LLM did not return a JSON object');
  const candidate = value as Record<string, unknown>;
  const fields = ['viralScore', 'noveltyScore', 'usefulnessScore', 'persianAudienceScore', 'visualScore'] as const;
  const result = {} as Record<(typeof fields)[number], number>;
  for (const field of fields) {
    const number = candidate[field];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > 100) {
      throw new Error(`Invalid ${field}`);
    }
    result[field] = number;
  }
  if (typeof candidate.reason !== 'string' || !candidate.reason.trim()) throw new Error('Invalid reason');
  return { ...result, reason: candidate.reason.trim().slice(0, 500) };
}

function average(score: Omit<TopicScoreInput, 'totalScore' | 'reason'>) {
  return Math.round((score.viralScore + score.noveltyScore + score.usefulnessScore + score.persianAudienceScore + score.visualScore) / 5);
}

function deterministicScore(title: string, description: string): TopicScoreInput {
  const text = `${title} ${description}`.toLowerCase();
  const noveltyScore = /new|launch|release|introduc/.test(text) ? 90 : 65;
  const visualScore = /image|video|model|demo/.test(text) ? 85 : 60;
  const usefulnessScore = /open|code|tool|agent/.test(text) ? 85 : 65;
  const viralScore = Math.round((noveltyScore + visualScore) / 2);
  const persianAudienceScore = 75;
  return {
    viralScore,
    noveltyScore,
    usefulnessScore,
    persianAudienceScore,
    visualScore,
    totalScore: Math.round((viralScore + noveltyScore + usefulnessScore + persianAudienceScore + visualScore) / 5),
    reason: 'امتیازدهی قطعیِ جایگزین؛ سرویس امتیازدهی هوش مصنوعی در دسترس نبود.',
  };
}
