/** Bindings, vars and secrets available to the Worker. Mirrors wrangler.jsonc + .dev.vars.example. */
export interface Env {
  // vars
  ANTHROPIC_MODEL: string;
  BRIEF_MODEL: string;
  REPORT_WEEKDAY: string;
  REPORT_HOUR_PT: string;
  BACKFILL_DAYS: string;
  NAME_ALIASES?: string;
  SLACK_EXTRA_CHANNELS?: string;
  /** Comma-separated Slack channel names never read (on top of the social / hiring name rules). */
  SLACK_SKIP_CHANNELS?: string;
  NOTION_CUSTOMERS_DS: string;
  NOTION_INSIGHTS_DS: string;
  NOTION_REPORTS_DS: string;
  NOTION_DIGESTS_DS: string;
  NOTION_PROMPTS_PAGE: string;
  SUPABASE_URL: string;
  HOME_DOMAIN: string;
  DOMAIN_ALIASES: string;

  // secrets
  ANTHROPIC_API_KEY: string;
  NOTION_TOKEN: string;
  SUPABASE_SERVICE_KEY: string;
  ATTIO_API_KEY: string;
  PYLON_API_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_CHANNEL_ID?: string;
  ADMIN_TOKEN: string;
  /** Password for the team-facing /connect page (separate from ADMIN_TOKEN). */
  CONNECT_TOKEN: string;
  /** base64 32-byte key that encrypts stored sign-ins. */
  TOKEN_ENC_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MS_CLIENT_ID: string;
  MS_TENANT_ID: string;
  MS_CLIENT_SECRET: string;
}

export function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
