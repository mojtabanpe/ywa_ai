import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ArticleMetadataService {
  private readonly logger = new Logger(ArticleMetadataService.name);

  async descriptionFor(url: string): Promise<string | undefined> {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'ywa-ai-discovery/1.0 (+content metadata)' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return undefined;
      const html = await response.text();
      return extractDescription(html);
    } catch (error) {
      this.logger.debug(`Could not enrich ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return undefined;
    }
  }
}

function extractDescription(html: string): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = attribute(tag, 'name')?.toLowerCase();
    const property = attribute(tag, 'property')?.toLowerCase();
    if (name !== 'description' && property !== 'og:description' && name !== 'twitter:description') continue;
    const content = attribute(tag, 'content');
    const normalized = content ? normalize(content) : undefined;
    if (normalized) return normalized;
  }
  return undefined;
}

function attribute(tag: string, key: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function normalize(value: string) {
  const decoded = value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return decoded ? decoded.slice(0, 800) : undefined;
}
