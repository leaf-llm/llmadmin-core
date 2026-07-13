import { Context } from 'hono';
import { POWERED_BY } from '../../globals';

const inMemoryCache: any = {};

const CACHE_STATUS = {
  HIT: 'HIT',
  SEMANTIC_HIT: 'SEMANTIC HIT',
  MISS: 'MISS',
  SEMANTIC_MISS: 'SEMANTIC MISS',
  REFRESH: 'REFRESH',
  DISABLED: 'DISABLED',
};

const getCacheKey = async (requestBody: any, url: string) => {
  const stringToHash = `${JSON.stringify(requestBody)}-${url}`;
  const myText = new TextEncoder().encode(stringToHash);
  let cacheDigest = await crypto.subtle.digest(
    {
      name: 'SHA-256',
    },
    myText
  );
  return Array.from(new Uint8Array(cacheDigest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

// Cache Handling
export const getFromCache = async (
  env: any,
  requestHeaders: any,
  requestBody: any,
  url: string,
  organisationId: string,
  cacheMode: string,
  cacheMaxAge: number | null
) => {
  if (`x-${POWERED_BY}-cache-force-refresh` in requestHeaders) {
    return [null, CACHE_STATUS.REFRESH, null];
  }
  try {
    const cacheKey = await getCacheKey(requestBody, url);

    if (cacheKey in inMemoryCache) {
      const cacheObject = inMemoryCache[cacheKey];
      if (cacheObject.maxAge && cacheObject.maxAge < Date.now()) {
        delete inMemoryCache[cacheKey];
        return [null, CACHE_STATUS.MISS, null];
      }
      return [cacheObject.responseBody, CACHE_STATUS.HIT, cacheKey];
    } else {
      return [null, CACHE_STATUS.MISS, null];
    }
  } catch (error) {
    console.error('getFromCache error: ', error);
    return [null, CACHE_STATUS.MISS, null];
  }
};

export const putInCache = async (
  env: any,
  requestHeaders: any,
  requestBody: any,
  responseBody: any,
  url: string,
  organisationId: string,
  cacheMode: string | null,
  cacheMaxAge: number | null
) => {
  if (requestBody.stream) {
    // Does not support caching of streams
    return;
  }

  const cacheKey = await getCacheKey(requestBody, url);

  inMemoryCache[cacheKey] = {
    responseBody: JSON.stringify(responseBody),
    maxAge: cacheMaxAge,
  };
};

export const memoryCache = () => {
  return async (c: Context, next: any) => {
    c.set('getFromCache', getFromCache);

    await next();

    let requestOptions = c.get('requestOptions');

    if (
      requestOptions &&
      Array.isArray(requestOptions) &&
      requestOptions.length > 0
    ) {
      // Pick the last 2xx attempt (or the last entry if all failed) — matches
      // the log middleware's pickActiveAttempt so the cached payload reflects
      // the response that was actually returned to the caller.
      let active = requestOptions[requestOptions.length - 1];
      for (let i = requestOptions.length - 1; i >= 0; i--) {
        const s = requestOptions[i]?.responseStatus;
        if (typeof s === 'number' && s >= 200 && s < 300) {
          active = requestOptions[i];
          break;
        }
      }
      requestOptions = active;
      if (requestOptions.requestParams.stream !== true) {
        if (requestOptions.cacheMode === 'simple') {
          await putInCache(
            null,
            null,
            requestOptions.transformedRequest.body,
            await requestOptions.response.clone().json(),
            requestOptions.providerOptions.rubeusURL,
            '',
            null,
            new Date().getTime() +
              (requestOptions.cacheMaxAge || 24 * 60 * 60 * 1000)
          );
        }
      }
    }
  };
};
