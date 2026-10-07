import { describe, expect, it } from "vitest";
import { CLAUDE_AUTO_MODE_SERVER_ENV, withClaudeGatewayDefaults } from "./provider-claude-gateway-defaults";

describe("withClaudeGatewayDefaults", () => {
  it("adds the auto-mode server default to a fragment without env", () => {
    expect(withClaudeGatewayDefaults({}, "custom")).toEqual({
      env: { [CLAUDE_AUTO_MODE_SERVER_ENV]: "0" },
    });
  });

  it("keeps existing env keys and appends the default", () => {
    const config = { env: { ANTHROPIC_BASE_URL: "https://gw.example.com" }, notes: "n" };
    expect(withClaudeGatewayDefaults(config, "custom")).toEqual({
      notes: "n",
      env: {
        ANTHROPIC_BASE_URL: "https://gw.example.com",
        [CLAUDE_AUTO_MODE_SERVER_ENV]: "0",
      },
    });
  });

  it("leaves the fragment untouched when the preset already carries the key", () => {
    const config = { env: { [CLAUDE_AUTO_MODE_SERVER_ENV]: "1" } };
    expect(withClaudeGatewayDefaults(config, "custom")).toBe(config);
  });

  it("skips official presets entirely", () => {
    const config = { env: {} };
    expect(withClaudeGatewayDefaults(config, "official")).toBe(config);
  });
});
