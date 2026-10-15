import * as core from '@actions/core';
import { save, safeMessage } from './cache.js';
import { InputError, type Options } from './types.js';

async function post(): Promise<void> {
  const state = core.getState('options');
  if (!state) return;
  try {
    // This state is private to this action invocation. Workflows sharing a UID
    // are trusted; it is not a credential or an authorization token.
    if (Buffer.byteLength(state) > 128 * 1024) throw new InputError('Invalid action state');
    const options = JSON.parse(state) as Options;
    if (
      options.repository !== process.env.GITHUB_REPOSITORY_ID ||
      options.workspace !== process.env.GITHUB_WORKSPACE
    )
      throw new InputError('Action state context changed');
    await save(options, core);
  } catch (error) {
    if (error instanceof InputError) core.setFailed(safeMessage(error));
    else core.warning(`Cache save unavailable: ${safeMessage(error)}`);
  }
}
await post();
