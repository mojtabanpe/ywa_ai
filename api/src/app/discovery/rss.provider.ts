import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DiscoveryProvider, ProviderItem } from './discovery.types';

@Injectable()
export class AiNewsRssProvider implements DiscoveryProvider {
  readonly name = 'Hugging Face Blog';
  readonly type = 'RSS' as const;
  readonly feedUrl = 'https://huggingface.co/blog/feed.xml';
  async collect(): Promise<ProviderItem[]> {
    const response = await fetch(this.feedUrl);
    if (!response.ok) throw new Error(`RSS request failed (${response.status})`);
    const xml = await response.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 30).flatMap((match) => {
      const field = (key: string) => match[1].match(new RegExp(`<${key}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${key}>`))?.[1]?.trim();
      const title = field('title'); const url = field('link');
      if (!title || !url) return [];
      const description = field('description')?.replace(/<[^>]+>/g, '').trim();
      const date = field('pubDate');
      return [{ externalId: createHash('sha256').update(url).digest('hex'), title, url, description, publishedAt: date ? new Date(date) : undefined, rawData: { provider: this.name } }];
    });
  }
}
