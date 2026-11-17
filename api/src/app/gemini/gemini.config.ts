export interface GeminiConfig {
  apiKey?: string;
  baseUrl: string;
  imageModel: string;
  omniModel: string;
}

export function resolveGeminiConfig(): GeminiConfig {
  return {
    apiKey: process.env.GEMINI_API_KEY,
    baseUrl: (process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
    imageModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
    omniModel: process.env.GEMINI_OMNI_MODEL || 'gemini-omni-flash-preview',
  };
}
