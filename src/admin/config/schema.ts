import { z } from 'zod';

const shortString = z.string().max(20_000);

const providerConfigSchema = z
  .object({
    id: z.string().min(1).max(200),
    apiKey: shortString.optional(),
    baseUrl: shortString.optional(),
    baseUrlAnthropic: shortString.optional(),
    lastSyncedAt: z.string().max(100).optional(),
    remark: z.string().max(500).optional(),
    apiFormat: z.enum(['openai', 'anthropic']).optional(),
  })
  .passthrough();

const routingEntrySchema = z
  .object({
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(500),
    configId: z.string().max(200).optional(),
    isPrimary: z.boolean().optional(),
  })
  .passthrough();

const userConfigSchema = z
  .unknown()
  .refine(
    (value) =>
      value === null ||
      (typeof value === 'object' && !Array.isArray(value)),
    { message: 'userConfig must be an object or null' }
  );

const categorySchema = z
  .object({
    routing: z.array(routingEntrySchema).max(2_000).default([]),
    userConfig: userConfigSchema.optional(),
  })
  .passthrough();

export const gatewaySchema = z
  .object({
    providers: z.record(z.string(), z.array(providerConfigSchema).max(200)).default({}),
    text: categorySchema.optional(),
    image: categorySchema.optional(),
    video: categorySchema.optional(),
    audio: categorySchema.optional(),
    mcp: categorySchema.optional(),
  })
  .passthrough();

export const settingsSchema = z
  .object({
    plugins_enabled: z.array(z.string().max(200)).max(100).optional(),
    credentials: z.record(z.any()).optional(),
    cache: z.boolean().optional(),
    integrations: z.array(z.any()).optional(),
    default_hooks: z.array(z.any()).optional(),
    presets_enabled: z.record(z.any()).optional(),
  })
  .passthrough();

export const unifiedConfigSchema = z
  .object({
    settings: settingsSchema.optional(),
    gateway: gatewaySchema.optional(),
    server: z.record(z.any()).optional(),
  })
  .passthrough();

export type ValidatedGateway = z.infer<typeof gatewaySchema>;
export type ValidatedUnifiedConfig = z.infer<typeof unifiedConfigSchema>;

export function parseGateway(input: unknown): ValidatedGateway {
  return gatewaySchema.parse(input);
}

export function parseUnifiedConfig(input: unknown): ValidatedUnifiedConfig {
  return unifiedConfigSchema.parse(input);
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');
}
