/**
 * Notion AI provider adapter.
 *
 * Connects to the local or remote Notion AI bridge service running notion_ai_auth.py.
 * Operates universally without a model selector; maps all requested models to Notion AI.
 */
import { HttpProvider, type HttpProviderOptions } from './http-provider.js';
import { type Provider, type ProviderRequest, type ProviderResponse } from './types.js';

export const DEFAULT_NOTION_BRIDGE_URL = 'http://127.0.0.1:8092';
export const DEFAULT_NOTION_TIMEOUT_MS = 600_000;

export interface NotionProviderOptions {
  readonly name?: string | undefined;
  /** Base URL of the Notion bridge service. Default 'http://127.0.0.1:8092'. */
  readonly baseUrl?: string | undefined;
  /** Extra headers per request (e.g. Bearer token). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Hard ceiling on response body size. Default 2 MiB. */
  readonly maxResponseBytes?: number | undefined;
  /** Whole-request deadline in milliseconds. Default 600 s (10 minutes). */
  readonly timeoutMs?: number | undefined;
  /** Allow a non-loopback endpoint. Default true. */
  readonly allowNonLoopback?: boolean | undefined;
}

export class NotionProvider implements Provider {
  readonly name: string;
  private readonly adapter: HttpProvider;

  constructor(opts: NotionProviderOptions = {}) {
    this.name = opts.name ?? 'notion';
    const httpOpts: HttpProviderOptions = {
      name: this.name,
      baseUrl: opts.baseUrl ?? DEFAULT_NOTION_BRIDGE_URL,
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      maxResponseBytes: opts.maxResponseBytes ?? 2 * 1024 * 1024,
      timeoutMs: opts.timeoutMs ?? DEFAULT_NOTION_TIMEOUT_MS,
      allowNonLoopback: opts.allowNonLoopback ?? true,
    };
    this.adapter = new HttpProvider(httpOpts);
  }

  complete(
    req: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse & { readonly usageReported: boolean }> {
    return this.adapter.complete(req, signal);
  }
}
