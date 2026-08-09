export interface LlmConfig {
  baseURL: string;
  apiKey: string | undefined;
  model: string;
}

export function resolveLlmConfig(): LlmConfig {
  if (process.env.LLM_PROVIDER === 'openai') {
    return {
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
    };
  }
  return {
    baseURL: process.env.LLM_API_BASE_URL || '',
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL || 'code',
  };
}
