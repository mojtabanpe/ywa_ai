export interface ProviderItem { externalId: string; url: string; author?: string; title: string; description?: string; publishedAt?: Date; rawData?: Record<string, unknown>; }
export interface DiscoveryProvider { readonly name: string; readonly type: 'RSS' | 'REDDIT' | 'YOUTUBE' | 'INSTAGRAM'; readonly feedUrl: string; collect(): Promise<ProviderItem[]>; }
