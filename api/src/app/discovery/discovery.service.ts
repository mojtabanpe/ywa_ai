import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AiNewsRssProvider } from './rss.provider';
import { ArticleMetadataService } from './article-metadata.service';
import { TopicScoringService } from './scoring.service';

@Injectable()
export class DiscoveryService {
  constructor(@InjectQueue('discovery') private readonly queue: Queue, private readonly prisma: PrismaService, private readonly rss: AiNewsRssProvider, private readonly metadata: ArticleMetadataService, private readonly scoring: TopicScoringService) {}
  async enqueue() {
    const run = await this.prisma.discoveryRun.create({ data: { currentStep: 'در صف اجرای Discovery' } });
    await this.prisma.discoveryRunLog.create({ data: { runId: run.id, message: 'درخواست Discovery ثبت شد و در صف قرار گرفت.' } });
    await this.queue.add('collect', { runId: run.id }, { removeOnComplete: 100, removeOnFail: 100 });
    return this.run(run.id);
  }
  async process(runId: string) {
    await this.recordProgress(runId, 5, 'اجرای Discovery شروع شد؛ در حال آماده‌سازی منابع…');
    await this.prisma.discoveryRun.update({ where: { id: runId }, data: { status: 'RUNNING', startedAt: new Date() } });
    try {
      const archived = await this.prisma.content.updateMany({
        where: { workflowStatus: 'DISCOVERED', archivedAt: null },
        data: { archivedAt: new Date() },
      });
      await this.recordProgress(runId, 12, `${archived.count} موضوع تأییدنشدهٔ قبلی آرشیو شد.`);
      const source = await this.prisma.source.upsert({ where: { type_url: { type: this.rss.type, url: this.rss.feedUrl } }, update: { name: this.rss.name }, create: { name: this.rss.name, type: this.rss.type, url: this.rss.feedUrl } });
      await this.recordProgress(runId, 20, `در حال دریافت RSS از ${source.name}…`);
      const items = await this.rss.collect();
      await this.recordProgress(runId, 30, `${items.length} موضوع از RSS دریافت شد.`);
      const existing = await this.prisma.content.findMany({ where: { sourceId: source.id, externalId: { in: items.map((item) => item.externalId) } }, select: { externalId: true, description: true } });
      const knownDescriptions = new Map(existing.map((content) => [content.externalId, content.description]));
      const enrichedItems = await mapWithConcurrency(items, 3, async (item) => ({
        ...item,
        description: item.description ?? knownDescriptions.get(item.externalId) ?? await this.metadata.descriptionFor(item.url),
      }));
      await this.recordProgress(runId, 50, 'استخراج توضیحات مقاله‌ها به پایان رسید.');
      for (const [index, item] of enrichedItems.entries()) {
        const content = await this.prisma.content.upsert({ where: { sourceId_externalId: { sourceId: source.id, externalId: item.externalId } }, update: { title: item.title, description: item.description, publishedAt: item.publishedAt, rawData: item.rawData as never, archivedAt: null }, create: { sourceId: source.id, ...item, rawData: item.rawData as never } });
        const score = await this.scoring.score(item.title, item.description ?? '');
        await this.prisma.contentScore.upsert({ where: { contentId: content.id }, update: score, create: { contentId: content.id, ...score } });
        const progress = 50 + Math.round(((index + 1) / enrichedItems.length) * 45);
        await this.recordProgress(runId, progress, `موضوع ${index + 1} از ${enrichedItems.length} ذخیره و امتیازدهی شد.`);
      }
      await this.prisma.discoveryRunLog.create({ data: { runId, message: 'Discovery با موفقیت کامل شد.' } });
      return this.prisma.discoveryRun.update({ where: { id: runId }, data: { status: 'COMPLETED', sourceCount: 1, itemCount: items.length, progress: 100, currentStep: 'Discovery کامل شد.', finishedAt: new Date() } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.prisma.$transaction([
        this.prisma.discoveryRun.update({ where: { id: runId }, data: { status: 'FAILED', error: message, progress: 100, currentStep: 'Discovery ناموفق بود.', finishedAt: new Date() } }),
        this.prisma.discoveryRunLog.create({ data: { runId, level: 'ERROR', message: 'Discovery ناموفق بود. لطفاً دوباره تلاش کنید.' } }),
      ]);
      throw error;
    }
  }
  async topTopics(limit = 5) {
    const include = { score: true, source: true, reelScript: true, scriptLogs: { orderBy: { createdAt: 'asc' }, take: 20 } } as const;
    const [topTopics, activeTopics] = await Promise.all([
      this.prisma.content.findMany({ where: { archivedAt: null }, take: limit, orderBy: { score: { totalScore: 'desc' } }, include }),
      this.prisma.content.findMany({ where: { workflowStatus: { not: 'DISCOVERED' }, archivedAt: null }, orderBy: { createdAt: 'desc' }, include }),
    ]);
    const uniqueTopics = new Map([...activeTopics, ...topTopics].map((topic) => [topic.id, topic]));
    return [...uniqueTopics.values()].map(({ source, ...topic }) => ({ ...topic, source: source.name }));
  }
  async run(id: string) {
    const run = await this.prisma.discoveryRun.findUnique({ where: { id }, include: { logs: { orderBy: { createdAt: 'asc' }, take: 100 } } });
    if (!run) throw new NotFoundException('Discovery run not found.');
    return run;
  }
  async runs() { return this.prisma.discoveryRun.findMany({ take: 10, orderBy: { createdAt: 'desc' }, include: { logs: { orderBy: { createdAt: 'asc' }, take: 100 } } }); }

  private async recordProgress(runId: string, progress: number, currentStep: string) {
    await this.prisma.$transaction([
      this.prisma.discoveryRun.update({ where: { id: runId }, data: { progress, currentStep } }),
      this.prisma.discoveryRunLog.create({ data: { runId, message: currentStep } }),
    ]);
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}
