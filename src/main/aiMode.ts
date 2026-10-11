// "Save OpenAI credits" mode (Config.lowAiMode, on by default). OpenAI costs the user real money, so everything that is
// not a core function of Clynx either runs without AI or doesn't run. Code deep in the pipeline asks isLowAiMode()
// instead of being handed the config; index.ts registers where to read the current setting from.

let readSetting: () => boolean = () => true;

export function registerLowAiModeSource(read: () => boolean): void {
  readSetting = read;
}

export function isLowAiMode(): boolean {
  try {
    return !!readSetting();
  } catch {
    return true;
  }
}
