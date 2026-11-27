import { createDefaultUnifiedConfig } from '../storage/defaults';
import type { UnifiedConfig } from '../storage/configStore';

/**
 * Seed document for a fresh demo session.
 *
 * Both "providers" point at the gateway's own mock upstream
 * (`/__demo/mock/v1`), so a visitor can explore routing, switching and the
 * playground without any real API key, any upstream cost, or any dependency on
 * a third-party service.
 */
export function buildDemoConfig(mockBaseUrl: string): UnifiedConfig {
  const base = mockBaseUrl.replace(/\/+$/, '');
  const doc = createDefaultUnifiedConfig();

  doc.settings.plugins_enabled = ['default'];
  doc.settings.cache = false;

  doc.gateway.providers = {
    'openai-compatible': [
      {
        id: 'demo-openai',
        apiKey: 'demo-key',
        baseUrl: base,
        apiFormat: 'openai',
        remark: '内置 Mock 上游 · OpenAI 协议',
      },
    ],
    'anthropic-compatible': [
      {
        id: 'demo-anthropic',
        apiKey: 'demo-key',
        baseUrl: base,
        baseUrlAnthropic: base,
        apiFormat: 'anthropic',
        remark: '内置 Mock 上游 · Anthropic 协议',
      },
    ],
  };

  doc.gateway.text = {
    routing: [
      {
        provider: 'openai-compatible',
        model: 'demo-fast',
        configId: 'demo-openai',
        isPrimary: true,
      },
      {
        provider: 'openai-compatible',
        model: 'demo-pro',
        configId: 'demo-openai',
        isPrimary: false,
      },
      {
        provider: 'anthropic-compatible',
        model: 'demo-sonnet',
        configId: 'demo-anthropic',
        isPrimary: false,
      },
    ],
    userConfig: {
      strategy: {
        mode: 'fallback',
        on_status_codes: [400, 402, 403, 424, 429, 500, 502, 503, 504],
      },
      targets: [
        {
          provider: 'openai',
          api_key: 'demo-key',
          custom_host: base,
          api_format: 'openai',
          override_params: { model: 'demo-fast' },
        },
        {
          provider: 'openai',
          api_key: 'demo-key',
          custom_host: base,
          api_format: 'openai',
          override_params: { model: 'demo-pro' },
        },
        {
          provider: 'anthropic',
          api_key: 'demo-key',
          custom_host: base,
          custom_host_anthropic: base,
          api_format: 'anthropic',
          override_params: { model: 'demo-sonnet' },
        },
      ],
    },
  };

  doc.server = { port: 8700, headless: true };

  return doc;
}
