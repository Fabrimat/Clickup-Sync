import axios, { AxiosInstance, InternalAxiosRequestConfig } from "axios";

/**
 * Token-bucket rate limiter.
 * ClickUp allows 100 requests/minute per token; we use 90 for safety margin.
 */
class RateLimiter {
  private tokens: number;
  private readonly max: number;
  private readonly refillPerMs: number;
  private lastRefill: number;

  constructor(maxPerMinute: number = 90) {
    this.max = maxPerMinute;
    this.tokens = maxPerMinute;
    this.refillPerMs = maxPerMinute / 60_000;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      await sleep(waitMs);
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.max,
      this.tokens + (now - this.lastRefill) * this.refillPerMs,
    );
    this.lastRefill = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One limiter per API key */
const limiters = new Map<string, RateLimiter>();

function getLimiter(apiKey: string): RateLimiter {
  let lim = limiters.get(apiKey);
  if (!lim) {
    lim = new RateLimiter();
    limiters.set(apiKey, lim);
  }
  return lim;
}

/**
 * Create an Axios client for the ClickUp API v2.
 * - Automatic rate limiting (token bucket, 90 req/min per key)
 * - Automatic retry on 429 (rate limited) with Retry-After header
 * - Debug request logging
 */
export function createClient(apiKey: string): AxiosInstance {
  const limiter = getLimiter(apiKey);

  const instance = axios.create({
    baseURL: "https://api.clickup.com/api/v2",
    timeout: 15_000,
    headers: { Authorization: apiKey },
  });

  // Rate-limit outgoing requests
  instance.interceptors.request.use(
    async (cfg: InternalAxiosRequestConfig) => {
      await limiter.acquire();
      console.debug(`[API] ${cfg.method?.toUpperCase()} ${cfg.url}`);
      return cfg;
    },
  );

  // Retry on 429
  instance.interceptors.response.use(undefined, async (error) => {
    if (error.response?.status === 429) {
      const retryAfter =
        Number(error.response.headers["retry-after"] || 60) * 1000;
      console.warn(`[RATE-LIMIT] 429 received, waiting ${retryAfter}ms`);
      await sleep(retryAfter);
      return instance.request(error.config);
    }
    throw error;
  });

  return instance;
}
