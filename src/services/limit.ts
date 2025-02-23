import { ApiProxy, RateLimitUnit } from "./repos/models";

function getRateLimitUnitInSecs(unit: RateLimitUnit): number {
	switch (unit) {
		case RateLimitUnit.MINUTE:
			return 60;
		case RateLimitUnit.HOUR:
			return 3600;
		case RateLimitUnit.DAY:
			return 86400;
		case RateLimitUnit.MONTH:
			return 2592000; // Assuming 30 days in a month
		default:
			throw new Error('Invalid RateLimitUnit');
	}
}

function getRateLimitKey(
	backmeshUid: string,
	proxyId: string,
	endUserId: string,
	windowStart: number,
) {
	return `limits/${backmeshUid}/${proxyId}/${endUserId}-${windowStart}`;
}

	// Sliding window rate limiting per user with retry logic
export default async function rateLimit(
  env: Env,
  backmeshUid: string,
  apiProxy: ApiProxy,
  endUserId: string,
  retryCount = 0,
): Promise<boolean> {
  const maxRetries = 3; // Maximum number of retries
  const now = Math.floor(Date.now() / 1000); // Current timestamp in seconds
  const rateLimitWindow = getRateLimitUnitInSecs(apiProxy.rateLimitUnit);
  const windowStart = Math.floor(now / rateLimitWindow) * rateLimitWindow;

  // Generate the KV key for this user and window
  const rateLimitKey = `${getRateLimitKey(backmeshUid, apiProxy.id, endUserId, windowStart)}`;

  // Get the current count from KV
  const value = await env.BACKMESH_KV.get(rateLimitKey);
  let count = value ? parseInt(value) : 0;

  // Check if the rate limit exceeded
  if (count >= apiProxy.rateLimit) {
    return true; // Rate limit exceeded
  }

  // Increment the count
  count += 1;

  // Try to update KV
  try {
    await env.BACKMESH_KV.put(rateLimitKey, count.toString(), {
      expirationTtl: rateLimitWindow, // Set expiration to the window duration
    });
    return false; // Rate limit not exceeded
  } catch (err: any) {
    // Only catch 429s
    if (!err.message.includes('429')) {
      throw err;
    }
    // Handle write contention or other errors
    if (retryCount < maxRetries) {
      const backoffTime = Math.random() * Math.pow(2, retryCount) * 100; // Exponential backoff in ms
      await new Promise((resolve) => setTimeout(resolve, backoffTime));
      return rateLimit(env, backmeshUid, apiProxy, endUserId, retryCount + 1); // Retry recursively
    } else {
      // Retries exhausted; fail gracefully
      console.error(`Failed to update rate limit after ${retryCount} retries`);
      return false;
    }
  }
};
