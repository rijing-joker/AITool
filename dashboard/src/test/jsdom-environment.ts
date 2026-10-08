import { builtinEnvironments, type Environment } from "vitest/environments";

export default {
  name: "jsdom-node",
  transformMode: "web",
  async setup(global, options) {
    // jsdom supplies the DOM, while fetch/Request come from Node. Node 24
    // rejects jsdom's AbortSignal, so keep Node's cancellation primitives
    // paired with its Request implementation (including router navigation).
    const { AbortController, AbortSignal } = global;
    const environment = await builtinEnvironments.jsdom.setup(global, options);
    global.AbortController = AbortController;
    global.AbortSignal = AbortSignal;
    return environment;
  },
} satisfies Environment;
