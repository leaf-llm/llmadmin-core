import { ZHIPU } from '../../globals';
import { ErrorResponse } from '../types';
import { generateErrorResponse } from '../utils';

/**
 * Marker field attached to a normalized Zhipu business-error envelope.
 * responseHandlers / streamHandler read this to decide whether to rewrite
 * the upstream HTTP status (200) into 424 Failed Dependency so that the
 * gateway's fallback chain can move on to the next target.
 */
export const ZHIPU_BUSINESS_ERROR_MARKER = '__zhipu_business_error';

/**
 * Detect a Zhipu (GLM) business-level failure.
 *
 * Zhipu returns HTTP 200 with a body of the shape:
 *   { code: <non-200>, msg: <string>, success: false }
 * in scenarios such as insufficient balance, model not found, or quota
 * exhausted. The gateway's fallback loop only checks HTTP status, so this
 * body would otherwise be treated as a successful response.
 *
 * Detection rules (any one is enough):
 *   - response.success === false
 *   - response.code is a number and !== 200
 */
export const isZhipuBusinessError = (response: any): boolean => {
  if (!response || typeof response !== 'object') return false;
  if (response.success === false) return true;
  if (typeof response.code === 'number' && response.code !== 200) return true;
  return false;
};

/**
 * Normalize a Zhipu business-error body into the gateway's standard
 * OpenAI-style ErrorResponse envelope, with a marker field so that the
 * response handlers can rewrite the upstream 200 status into 424.
 */
export const buildZhipuBusinessErrorResponse = (
  response: any
): ErrorResponse => {
  const message =
    response?.msg ||
    response?.message ||
    `Zhipu business error: ${JSON.stringify(response)}`;
  const code = response?.code != null ? String(response.code) : null;
  const generated = generateErrorResponse(
    { message, type: 'zhipu_business_error', param: null, code },
    ZHIPU
  );
  (generated as any)[ZHIPU_BUSINESS_ERROR_MARKER] = true;
  return generated;
};