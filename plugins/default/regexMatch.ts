import {
  HookEventType,
  PluginContext,
  PluginHandler,
  PluginParameters,
} from '../types';
import { getText } from '../utils';

export const handler: PluginHandler = async (
  context: PluginContext,
  parameters: PluginParameters,
  eventType: HookEventType
) => {
  let error = null;
  let verdict = false;
  let data: any = null;
  try {
    const regexPattern = parameters.rule;
    const not = parameters.not || false;
    let textToMatch = getText(context, eventType);

    if (!regexPattern) {
      throw new Error('Missing regex pattern');
    }

    if (!textToMatch) {
      throw new Error('Missing text to match');
    }

    const regex = new RegExp(regexPattern);
    const match = regex.exec(textToMatch);

    // Determine verdict based on not parameter
    const matches = match !== null;
    // not=false: we want to ensure the text does NOT contain the pattern
    //   (e.g. PII). A match → verdict=false (content is unsafe).
    // not=true:  we want to ensure the text DOES contain the pattern.
    //   No match → verdict=false (content is unsafe).
    verdict = not ? matches : !matches;

    data = {
      regexPattern,
      not,
      verdict,
      explanation: verdict
        ? `The regex pattern '${regexPattern}' ${not ? 'matched' : 'did not match'} the text${not ? ' as expected.' : '.'}`
        : `The regex pattern '${regexPattern}' ${not ? 'did not match' : 'matched'} the text${not ? ' when it was expected to.' : ' when it should not have.'}`,
      matchDetails: match
        ? {
            matchedText: match[0],
            index: match.index,
            groups: match.groups || {},
            captures: match.slice(1),
          }
        : null,
      textExcerpt:
        textToMatch.length > 100
          ? textToMatch.slice(0, 100) + '...'
          : textToMatch,
    };
  } catch (e: any) {
    error = e;
    let textExcerpt = getText(context, eventType);
    textExcerpt =
      textExcerpt?.length > 100
        ? textExcerpt.slice(0, 100) + '...'
        : textExcerpt;
    data = {
      explanation: `An error occurred while processing the regex: ${e.message}`,
      regexPattern: parameters.rule,
      not: parameters.not || false,
      textExcerpt: textExcerpt || 'No text available',
    };
  }

  return { error, verdict, data };
};
