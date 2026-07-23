export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  SESSION_SECRET: string;
  CORS_ORIGINS: string;
  DEFAULT_ORG_ID: string;
  DEEPSEEK_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  [key: string]: unknown;
}

export interface UserAuth {
  apiKeyId: string;
  userId: string;
  organizationId: string;
  name: string;
  status: string;
  creditBalance: number;
  dailyCreditLimit: number | null;
  monthlyCreditLimit: number | null;
}

export interface ModelRow {
  id: string;
  organization_id: string;
  public_name: string;
  provider_type: string;
  base_url: string;
  secret_binding_name: string;
  upstream_model: string;
  input_price_per_million: number;
  output_price_per_million: number;
  cached_input_price_per_million: number;
  internal_markup_bps: number;
  max_output_tokens: number;
  supports_streaming: number;
  status: string;
}
