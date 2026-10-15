/**
 * Firecrawl Search backend for dsh-sophiasearch.
 * REST API: https://api.firecrawl.dev/v2/search
 * Auth: Bearer token (FIRECRAWL_API_KEY)
 * Response: { success, data: { web: [{ title, url, description }] } }
 *
 * Ported from @liustack/modsearch's `firecrawl` engine so this plugin keeps
 * working after modsearch is uninstalled.
 */

import { WebError } from "@deepseek-ai/dsh-web";
import { throwIfSearchAborted, searchAborted, isAbortError } from "../util/abort.js";

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/search";
const MAX_LIMIT = 20;

/** @type {import("../provider.js").Backend} */
export const firecrawlBackend = {
  id: "firecrawl",
  requiresCredential: true,

  available(options) {
    return typeof options?.resolveApiKey === "function";
  },

  async search(request, signal, options, hooks) {
    throwIfSearchAborted(signal);
    const backendOpts = options ?? {};

    const apiKey = await backendOpts.resolveApiKey?.();
    if (!apiKey) {
      throw new WebError("Firecrawl: API key not configured", "WEB_PROVIDER_UNAVAILABLE");
    }

    const baseURL = backendOpts.baseURL ?? FIRECRAWL_ENDPOINT;
    const limit = Math.min(request.maxResults ?? 10, MAX_LIMIT);
    const body = {
      query: request.query,
      limit,
      sources: ["web"],
    };

    hooks?.recordRequest?.({
      endpoint: baseURL,
      toolName: "firecrawl_search",
      body,
    });

    let response;
    try {
      response = await fetch(baseURL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "dsh-sophiasearch/1.0",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      throw new WebError(`Firecrawl request failed: ${error}`, "WEB_PROVIDER_ERROR", { cause: error });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "").then((tx) => tx.slice(0, 300));
      hooks?.recordOutcome?.({ status: "error", message: `HTTP ${response.status}: ${text}` });
      throw new WebError(`Firecrawl API error (HTTP ${response.status}): ${text}`, "WEB_PROVIDER_ERROR");
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new WebError("Firecrawl: invalid JSON response", "WEB_PROVIDER_ERROR", { cause: error });
    }

    const parsed = parseFirecrawlResult(data, request.maxResults ?? 10);
    hooks?.recordOutcome?.({ status: "success", count: parsed.sources.length });
    return parsed;
  },
};

/**
 * Parse a Firecrawl /v2/search response. v1 returned `data: [...]`; v2 nests
 * the ranked web results under `data.web`. Both shapes are accepted.
 * @param {object} data
 * @param {number} maxResults
 */
export function parseFirecrawlResult(data, maxResults) {
  const raw = Array.isArray(data?.data) ? data.data : (data?.data?.web ?? []);
  const sources = [];
  for (const item of raw) {
    if (sources.length >= maxResults) break;
    const url = item?.url ?? item?.metadata?.sourceURL;
    if (!url) continue;
    sources.push({
      url,
      ...(item.title ?? item.metadata?.title ? { title: item.title ?? item.metadata.title } : {}),
      ...(item.description ?? item.metadata?.description
        ? { snippet: String(item.description ?? item.metadata.description).slice(0, 500) }
        : {}),
    });
  }
  return { sources };
}
