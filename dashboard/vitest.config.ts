import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { copyRegistryPlugin } from "./scripts/copy-registry-plugin.mjs";

export default defineConfig({
  plugins: [copyRegistryPlugin(), react()],
  test: {
    environment: "./src/test/jsdom-environment.ts",
    setupFiles: ["./src/test/setupTests.ts"],
    include: ["src/**/*.test.{js,jsx,ts,tsx}"],
    globals: true,
  },
});
