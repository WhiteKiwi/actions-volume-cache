import * as core from '@actions/core';
import { restore, safeMessage } from './cache.js';
import { optionsFrom } from './options.js';
import { validateOptions } from './paths.js';
import { InputError } from './types.js';

async function main(): Promise<void> {
  core.setOutput('cache-hit', '');
  try {
    const options = await validateOptions(optionsFrom((name) => core.getInput(name)));
    core.saveState('options', JSON.stringify(options));
    try {
      core.setOutput('cache-hit', await restore(options, core));
    } catch (error) {
      if (error instanceof InputError) throw error;
      core.warning(`Cache unavailable: ${safeMessage(error)}`);
    }
  } catch (error) {
    core.setFailed(safeMessage(error));
  }
}
await main();
