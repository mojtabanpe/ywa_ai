import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import axios, { AxiosProxyConfig } from 'axios';
import { resolveGeminiConfig } from './gemini.config';

type GeminiModality = 'TEXT' | 'IMAGE' | 'AUDIO';

export interface GeminiRequest {
  prompt: string;
  responseModalities?: GeminiModality[];
  inputMedia?: { mimeType: string; data: string };
}

export interface GeminiResult {
  model: string;
  text?: string;
  media: Array<{ mimeType: string; data: string }>;
  usage?: unknown;
}

@Injectable()
export class GeminiService {
  status() {
    const config = resolveGeminiConfig();
    return {
      configured: Boolean(config.apiKey),
      baseUrl: config.baseUrl,
      imageModel: config.imageModel,
      omniModel: config.omniModel,
      proxyConfigured: Boolean(proxyUrl()),
    };
  }

  generateImage(prompt: string) {
    return this.generate(resolveGeminiConfig().imageModel, {
      prompt,
      responseModalities: ['TEXT', 'IMAGE'],
    });
  }

  generateOmni(request: GeminiRequest) {
    return this.generate(resolveGeminiConfig().omniModel, {
      ...request,
      responseModalities: request.responseModalities?.length ? request.responseModalities : ['TEXT'],
    });
  }

  private async generate(model: string, request: GeminiRequest): Promise<GeminiResult> {
    const config = resolveGeminiConfig();
    if (!config.apiKey) throw new BadRequestException('GEMINI_API_KEY is not configured.');
    const prompt = request.prompt?.trim();
    if (!prompt || prompt.length > 8_000) throw new BadRequestException('prompt must contain 1–8000 characters.');
    const modalities = validateModalities(request.responseModalities);
    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    if (request.inputMedia) {
      if (!request.inputMedia.mimeType?.trim() || !request.inputMedia.data?.trim()) {
        throw new BadRequestException('inputMedia requires mimeType and base64 data.');
      }
      parts.push({ inlineData: { mimeType: request.inputMedia.mimeType.trim(), data: request.inputMedia.data } });
    }

    try {
      const response = await axios.post(`${config.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: modalities },
      }, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        timeout: 120_000,
        proxy: resolveProxy(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return parseResult(model, response.data);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const detail = typeof error.response.data === 'string'
          ? error.response.data.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
          : extractError(error.response.data);
        throw new BadGatewayException(`Gemini ${model} failed with HTTP ${error.response.status}${detail ? `: ${detail}` : ''}`);
      }
      const route = proxyUrl() ? ' through the configured proxy' : '';
      throw new BadGatewayException(`Gemini request could not connect${route}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}

function proxyUrl() {
  return process.env.GEMINI_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
}

function resolveProxy(): AxiosProxyConfig | false {
  const value = proxyUrl();
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('GEMINI_PROXY_URL is not a valid URL.');
  }
  const protocol = url.protocol.replace(':', '');
  if (protocol !== 'http' && protocol !== 'https') {
    throw new BadRequestException('Gemini proxy must use http:// or https://.');
  }
  return {
    protocol,
    host: url.hostname,
    port: url.port ? Number(url.port) : protocol === 'https' ? 443 : 80,
    ...(url.username ? { auth: { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } } : {}),
  };
}

function validateModalities(value?: GeminiModality[]) {
  const modalities = value?.length ? [...new Set(value)] : ['TEXT'];
  if (modalities.some((item) => !['TEXT', 'IMAGE', 'AUDIO'].includes(item))) {
    throw new BadRequestException('responseModalities may only contain TEXT, IMAGE, or AUDIO.');
  }
  return modalities;
}

function extractError(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const error = (payload as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message.slice(0, 500) : '';
}

function parseResult(model: string, payload: unknown): GeminiResult {
  const data = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; inlineData?: { mimeType?: unknown; data?: unknown } }> } }>;
    usageMetadata?: unknown;
  };
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.flatMap((part) => typeof part.text === 'string' ? [part.text] : []).join('\n').trim() || undefined;
  const media = parts.flatMap((part) => {
    const item = part.inlineData;
    return item && typeof item.mimeType === 'string' && typeof item.data === 'string'
      ? [{ mimeType: item.mimeType, data: item.data }]
      : [];
  });
  if (!text && !media.length) throw new BadGatewayException(`Gemini ${model} returned no usable content.`);
  return { model, text, media, usage: data.usageMetadata };
}
