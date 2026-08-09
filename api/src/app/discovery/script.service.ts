import { BadGatewayException, BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { resolveLlmConfig } from '../llm/llm.config';
import { PrismaService } from '../prisma/prisma.service';

interface ScriptDraft {
  hook: string;
  narration: string;
  visualPlan: string;
  caption: string;
  cta: string;
}

@Injectable()
export class ScriptService {
  constructor(private readonly prisma: PrismaService) {}

  async approve(contentId: string) {
    await this.findContent(contentId);
    return this.prisma.content.update({ where: { id: contentId }, data: { workflowStatus: 'APPROVED', scriptError: null, scriptProgress: 0 } });
  }

  async generate(contentId: string) {
    const content = await this.findContent(contentId);
    if (content.workflowStatus === 'DISCOVERED') {
      throw new BadRequestException('Approve the topic before generating its script.');
    }
    if (content.workflowStatus === 'SCRIPT_GENERATING') {
      throw new ConflictException('Script generation is already in progress.');
    }
    await this.prisma.$transaction([
      this.prisma.scriptGenerationLog.deleteMany({ where: { contentId } }),
      this.prisma.content.update({ where: { id: contentId }, data: { workflowStatus: 'SCRIPT_GENERATING', scriptError: null, scriptProgress: 5 } }),
      this.prisma.scriptGenerationLog.create({ data: { contentId, message: 'درخواست ساخت سناریو ثبت شد.' } }),
    ]);
    try {
      await this.recordProgress(contentId, 15, 'در حال آماده‌سازی اطلاعات موضوع برای مدل…');
      await this.recordProgress(contentId, 30, 'در انتظار پاسخ مدل هوش مصنوعی…');
      const draft = await this.requestDraft(content.title, content.description ?? '');
      await this.recordProgress(contentId, 75, 'پاسخ مدل دریافت شد؛ در حال بررسی ساختار سناریو…');
      const script = await this.prisma.reelScript.upsert({
        where: { contentId },
        update: { ...draft, model: resolveLlmConfig().model },
        create: { contentId, ...draft, model: resolveLlmConfig().model },
      });
      await this.recordProgress(contentId, 95, 'سناریو ذخیره شد؛ در حال نهایی‌سازی…');
      await this.prisma.$transaction([
        this.prisma.content.update({ where: { id: contentId }, data: { workflowStatus: 'SCRIPT_READY', scriptError: null, scriptProgress: 100 } }),
        this.prisma.scriptGenerationLog.create({ data: { contentId, message: 'سناریو با موفقیت آماده شد.' } }),
      ]);
      return script;
    } catch (error) {
      await this.prisma.$transaction([
        this.prisma.content.update({ where: { id: contentId }, data: { workflowStatus: 'SCRIPT_FAILED', scriptError: 'تولید سناریو ناموفق بود. دوباره تلاش کنید.', scriptProgress: 100 } }),
        this.prisma.scriptGenerationLog.create({ data: { contentId, level: 'ERROR', message: 'تولید سناریو ناموفق بود. می‌توانید دوباره تلاش کنید.' } }),
      ]);
      throw error;
    }
  }

  async get(contentId: string) {
    await this.findContent(contentId);
    return this.prisma.reelScript.findUnique({ where: { contentId } });
  }

  private async findContent(id: string) {
    const content = await this.prisma.content.findUnique({ where: { id } });
    if (!content) throw new NotFoundException('Topic not found.');
    return content;
  }

  private async requestDraft(title: string, description: string): Promise<ScriptDraft> {
    const llm = resolveLlmConfig();
    if (!llm.baseURL || !llm.apiKey) throw new BadRequestException('LLM configuration is missing.');
    try {
      const response = await axios.post(`${llm.baseURL.replace(/\/$/, '')}/chat/completions`, {
        model: llm.model, temperature: 0.55, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Create a factual 35-45 second Persian Instagram Reel script about AI. Return only valid JSON with hook, narration, visualPlan, caption, and cta. narration must be natural Persian, concise, and under 115 Persian words. visualPlan must give 3-5 short visual beats. Do not invent claims beyond the supplied topic.' },
          { role: 'user', content: `Topic: ${title}\nSource description: ${description || '(none)'}` },
        ],
      }, { headers: { Authorization: `Bearer ${llm.apiKey}`, 'Content-Type': 'application/json' }, timeout: 30_000 });
      return validateDraft(parseContent(response.data));
    } catch {
      throw new BadGatewayException('LLM script generation failed. Please retry.');
    }
  }

  private async recordProgress(contentId: string, scriptProgress: number, message: string) {
    await this.prisma.$transaction([
      this.prisma.content.update({ where: { id: contentId }, data: { scriptProgress } }),
      this.prisma.scriptGenerationLog.create({ data: { contentId, message } }),
    ]);
  }
}

function parseContent(payload: unknown): unknown {
  if (typeof payload !== 'string') return (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  const line = payload.split('\n').find((value) => value.startsWith('data: ') && !value.includes('[DONE]'));
  if (!line) throw new BadRequestException('LLM returned no completion.');
  return JSON.parse(line.slice(6)).choices?.[0]?.message?.content;
}

function validateDraft(value: unknown): ScriptDraft {
  const parsed = typeof value === 'string' ? JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) : value;
  if (!parsed || typeof parsed !== 'object') throw new BadRequestException('LLM returned an invalid script.');
  const candidate = parsed as Record<string, unknown>;
  const fields = ['hook', 'narration', 'visualPlan', 'caption', 'cta'] as const;
  const draft = {} as Record<(typeof fields)[number], string>;
  for (const field of fields) {
    if (typeof candidate[field] !== 'string' || !candidate[field].trim()) throw new BadRequestException(`LLM returned an invalid ${field}.`);
    draft[field] = candidate[field].trim().slice(0, 2_000);
  }
  return draft;
}
