// Profiles (cc-switch's services/profile): named snapshots of one app's
// pswitch state — the current provider, the enabled MCP server ids, the
// enabled skill ids and the active prompt — that can be re-applied later.
// Payload slots are null when that side never snapshotted (apply leaves it
// untouched) and Some(empty) when the snapshot captured an empty state
// (apply clears it) — upstream's None-vs-empty distinction.
//
// Scope = one app. Upstream scopes are claude/claude-desktop/codex; the fork
// generalizes to every app whose pswitch surface carries all four slots
// (openclaw has no MCP/skills support and stays outside profiles).

const crypto = require("node:crypto");
const { readJson, updateJsonLocked, ensureDir } = require("../fs");
const paths = require("./paths");
const store = require("./store");
const mcp = require("./mcp");
const skills = require("./skills");
const prompts = require("./prompts");

const PROFILE_APPS = ["claude", "codex", "gemini", "grokbuild", "opencode", "hermes", "mcode", "pi"];

function isProfileApp(app) {
  return PROFILE_APPS.includes(app);
}

function defaultStore() {
  const currentIds = {};
  for (const app of PROFILE_APPS) currentIds[app] = null;
  return { version: 1, profiles: [], currentIds };
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : {};
  const slot = (group) => {
    const value = payload[group];
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  };
  return {
    id: raw.id,
    name: raw.name,
    payload: {
      providers: slot("providers"),
      mcp: slot("mcp"),
      skills: slot("skills"),
      prompts: slot("prompts"),
    },
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

async function readProfilesStore() {
  const raw = await readJson(paths.profilesStorePath());
  if (!raw || typeof raw !== "object") return defaultStore();
  const next = defaultStore();
  if (Array.isArray(raw.profiles)) {
    next.profiles = raw.profiles.map(normalizeProfile).filter(Boolean);
  }
  if (raw.currentIds && typeof raw.currentIds === "object") {
    for (const app of PROFILE_APPS) {
      if (typeof raw.currentIds[app] === "string") next.currentIds[app] = raw.currentIds[app];
    }
  }
  return next;
}

async function mutateProfilesStore(update) {
  await ensureDir(paths.providerSwitchRoot());
  return updateJsonLocked(paths.profilesStorePath(), (current) => {
    const store = current && typeof current === "object" && Array.isArray(current.profiles)
      ? current
      : defaultStore();
    const normalized = defaultStore();
    normalized.profiles = (Array.isArray(store.profiles) ? store.profiles : [])
      .map(normalizeProfile)
      .filter(Boolean);
    if (store.currentIds && typeof store.currentIds === "object") {
      for (const app of PROFILE_APPS) {
        if (typeof store.currentIds[app] === "string") normalized.currentIds[app] = store.currentIds[app];
      }
    }
    const next = update(normalized);
    return next === undefined ? normalized : next;
  });
}

async function listProfiles() {
  const profiles = await readProfilesStore();
  return { profiles: profiles.profiles, currentIds: profiles.currentIds };
}

// Any non-null slot for this app means the profile captured its state; a
// never-snapshotted app applies with no config changes (upstream
// hasScopeSnapshot).
function scopeCaptured(profile, app) {
  return (
    profile.payload.providers[app] != null
    || profile.payload.mcp[app] != null
    || profile.payload.skills[app] != null
    || profile.payload.prompts[app] != null
  );
}

async function snapshotApp(app) {
  if (!isProfileApp(app)) throw new Error(`Profiles are not supported for app: ${app}`);
  const [providerState, servers, allSkills, appPrompts] = await Promise.all([
    store.listProviders(app),
    mcp.listServers(),
    skills.listSkills(),
    prompts.listPrompts(app),
  ]);
  // Every app starts as null (never captured); only the initiating app's
  // slots are filled — other apps may be living in another profile.
  const providers = nullSlots();
  const mcpSlots = nullSlots();
  const skillSlots = nullSlots();
  const promptSlots = nullSlots();
  providers[app] = providerState.current;
  mcpSlots[app] = servers.filter((s) => s.apps?.[app] === true).map((s) => s.id);
  skillSlots[app] = allSkills.filter((s) => s.apps?.[app] === true).map((s) => s.id);
  promptSlots[app] = (appPrompts.find((p) => p.enabled) || {}).id || null;
  return { providers, mcp: mcpSlots, skills: skillSlots, prompts: promptSlots };
}

function nullSlots() {
  const slots = {};
  for (const slotApp of PROFILE_APPS) slots[slotApp] = null;
  return slots;
}

// Create: snapshot only the initiating app's slots (upstream create) — other
// apps may be living in another profile and must not be captured silently.
async function createProfile({ name, app }) {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("Profile name is empty");
  if (!isProfileApp(app)) throw new Error(`Profiles are not supported for app: ${app}`);
  const snapshot = await snapshotApp(app);
  const now = new Date().toISOString();
  const profile = {
    id: `pr_${crypto.randomUUID()}`,
    name: trimmed.slice(0, 100),
    payload: snapshot,
    createdAt: now,
    updatedAt: now,
  };
  await mutateProfilesStore((store) => {
    store.profiles.push(profile);
    return store;
  });
  return profile;
}

// Update: rename and/or resnapshot the given app's slots. The bundled UI only
// renames — resnapshot normally runs through apply's automatic
// save-before-switch, but unlike upstream the fork keeps a manual path open:
// POST profiles/update forwards resnapshot for local API clients.
async function updateProfile({ id, name, resnapshot, app }) {
  let updated = null;
  await mutateProfilesStore((profileStore) => {
    const index = profileStore.profiles.findIndex((p) => p.id === id);
    if (index === -1) return profileStore;
    const profile = profileStore.profiles[index];
    if (name !== undefined) {
      const trimmed = String(name || "").trim();
      if (!trimmed) throw new Error("Profile name is empty");
      profile.name = trimmed.slice(0, 100);
    }
    updated = profile;
    return profileStore;
  });
  if (!updated) throw new Error(`Profile not found: ${id}`);
  if (resnapshot) {
    if (!isProfileApp(app)) throw new Error(`Profiles are not supported for app: ${app}`);
    const snapshot = await snapshotApp(app);
    await mutateProfilesStore((profileStore) => {
      const index = profileStore.profiles.findIndex((p) => p.id === id);
      if (index === -1) return profileStore;
      const profile = profileStore.profiles[index];
      profile.payload = { ...profile.payload, ...snapshot };
      profile.updatedAt = new Date().toISOString();
      return profileStore;
    });
  }
  return updateProfileReadback(id);
}

async function updateProfileReadback(id) {
  const profiles = await readProfilesStore();
  return profiles.profiles.find((p) => p.id === id) || null;
}

async function deleteProfile(id) {
  await mutateProfilesStore((profileStore) => {
    profileStore.profiles = profileStore.profiles.filter((p) => p.id !== id);
    for (const app of PROFILE_APPS) {
      if (profileStore.currentIds[app] === id) profileStore.currentIds[app] = null;
    }
    return profileStore;
  });
}

// Minimal-toggle diff (upstream plan_toggles): only entries whose target
// state differs from the current state are toggled; ids that no longer exist
// come back as dangling for the caller's warnings.
function planToggles(currentEntries, targetIds) {
  const targets = new Set(Array.isArray(targetIds) ? targetIds : []);
  const toggles = [];
  const dangling = [];
  for (const [id, enabled] of currentEntries) {
    if (!id) continue;
    if (targets.has(id)) {
      if (!enabled) toggles.push([id, true]);
      targets.delete(id);
    } else if (enabled) {
      toggles.push([id, false]);
    }
  }
  for (const id of targets) dangling.push(id);
  return { toggles, dangling };
}

// Apply a profile's snapshot to one app (best-effort, warnings returned).
// Before switching, the previously-current profile of this app is resnapshot
// automatically so it keeps the state the user is leaving behind; an autosave
// failure is a warning, never a blocker. `applyProvider(app, providerId)` is
// injected by api.js (the full switch projection).
async function applyProfile({ id, app, applyProvider }) {
  if (!isProfileApp(app)) throw new Error(`Profiles are not supported for app: ${app}`);
  const warnings = [];
  const profileStore = await readProfilesStore();

  const previousId = profileStore.currentIds[app];
  if (previousId && previousId !== id) {
    try {
      await updateProfile({ id: previousId, resnapshot: true, app });
    } catch (error) {
      warnings.push(`autosave profile '${previousId}' before switch failed: ${error?.message || error}`);
    }
  }

  const profile = profileStore.profiles.find((p) => p.id === id);
  if (!profile) throw new Error(`Profile not found: ${id}`);
  const payload = profile.payload;

  if (!scopeCaptured(profile, app)) {
    warnings.push(`no ${app} configuration captured in this profile yet; marked as current without changes (it will be saved automatically when you switch away)`);
  }

  // 1. Providers: switch only when the snapshot's provider still exists.
  const targetPid = payload.providers[app];
  if (targetPid != null) {
    const state = await store.listProviders(app);
    if (!state.providers.some((p) => p.id === targetPid)) {
      warnings.push(`[${app}] provider '${targetPid}' no longer exists, skipped`);
    } else if (state.current !== targetPid) {
      try {
        await applyProvider(app, targetPid);
      } catch (error) {
        warnings.push(`[${app}] switch provider '${targetPid}' failed: ${error?.message || error}`);
      }
    }
  }

  // 2. MCP diff (minimal toggles).
  const targetMcp = payload.mcp[app];
  if (targetMcp != null) {
    const servers = await mcp.listServers();
    const { toggles, dangling } = planToggles(servers.map((s) => [s.id, s.apps?.[app] === true]), targetMcp);
    for (const serverId of dangling) warnings.push(`[${app}] MCP '${serverId}' no longer exists, skipped`);
    for (const [serverId, enabled] of toggles) {
      try {
        await mcp.toggleServerApp(serverId, app, enabled);
      } catch (error) {
        warnings.push(`[${app}] toggle MCP '${serverId}' -> ${enabled} failed: ${error?.message || error}`);
      }
    }
  }

  // 3. Skills diff (minimal toggles).
  const targetSkills = payload.skills[app];
  if (targetSkills != null) {
    const allSkills = await skills.listSkills();
    const { toggles, dangling } = planToggles(allSkills.map((s) => [s.id, s.apps?.[app] === true]), targetSkills);
    for (const skillId of dangling) warnings.push(`[${app}] skill '${skillId}' no longer exists, skipped`);
    for (const [skillId, enabled] of toggles) {
      try {
        await skills.toggleSkill(skillId, app, enabled);
      } catch (error) {
        warnings.push(`[${app}] toggle skill '${skillId}' -> ${enabled} failed: ${error?.message || error}`);
      }
    }
  }

  // 4. Prompts: enable the snapshot's prompt when it still exists.
  const targetPrompt = payload.prompts[app];
  if (targetPrompt != null) {
    const appPrompts = await prompts.listPrompts(app);
    const enabled = appPrompts.find((p) => p.enabled);
    if (appPrompts.some((p) => p.id === targetPrompt)) {
      if (!enabled || enabled.id !== targetPrompt) {
        try {
          await prompts.enablePrompt(app, targetPrompt);
        } catch (error) {
          warnings.push(`[${app}] enable prompt '${targetPrompt}' failed: ${error?.message || error}`);
        }
      }
    } else {
      warnings.push(`[${app}] prompt '${targetPrompt}' no longer exists, skipped`);
    }
  }

  await mutateProfilesStore((profileStore) => {
    profileStore.currentIds[app] = id;
    return profileStore;
  });

  return { ok: true, warnings };
}

module.exports = {
  PROFILE_APPS,
  isProfileApp,
  listProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
  applyProfile,
  planToggles,
  // exported for tests
  scopeCaptured,
};
