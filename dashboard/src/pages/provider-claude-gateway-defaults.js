// cc-switch's claudeEditorOverlay.withClaudeGatewayDefaults: auto mode's
// server-side check only exists on official endpoints, so Claude Code pops a
// per-session confirmation through every gateway. New Claude providers
// therefore start with CLAUDE_CODE_AUTO_MODE_SERVER=0 (Claude Code's own
// check) unless the preset is official or already carries the key — the row
// owns the key, so switching it in writes it and switching away clears it.

export const CLAUDE_AUTO_MODE_SERVER_ENV = "CLAUDE_CODE_AUTO_MODE_SERVER";

export function withClaudeGatewayDefaults(settingsConfig, category) {
  if (category === "official") return settingsConfig;
  const config = settingsConfig && typeof settingsConfig === "object" && !Array.isArray(settingsConfig)
    ? settingsConfig
    : {};
  const env = config.env && typeof config.env === "object" && !Array.isArray(config.env) ? config.env : {};
  if (CLAUDE_AUTO_MODE_SERVER_ENV in env) return config;
  return { ...config, env: { ...env, [CLAUDE_AUTO_MODE_SERVER_ENV]: "0" } };
}
