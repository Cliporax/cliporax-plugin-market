export interface PluginState {
  ready: boolean;
}

export async function activate(): Promise<PluginState> {
  return { ready: true };
}

export async function deactivate(): Promise<PluginState> {
  return { ready: false };
}
