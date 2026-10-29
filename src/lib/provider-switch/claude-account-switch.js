"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeFileAtomic, withFileLock } = require("../fs");
const native = require("./claude-account-runtime");
const newId = () => crypto.randomBytes(16).toString("hex");
function profileWith(profile, oauthAccount) {
  const next = structuredClone(profile || {});
  if (oauthAccount) next.oauthAccount = oauthAccount; else delete next.oauthAccount;
  for (const key of native.CACHE_KEYS) delete next[key];
  next.hasCompletedOnboarding ??= true;
  return next;
}
function createSwitcher(runtime, { load, save }) {
  const journalFile = path.join(runtime.root, "switch-journal.json");
  const lockFile = path.join(runtime.root, "switch");
  const encoded = slot => slot.default ? "default" : path.basename(path.dirname(slot.dir));
  const decoded = value => value === "default" ? runtime.defaultSlot : runtime.slot(value);
  const journal = value => writeFileAtomic(journalFile, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  const restoreProjection = async value => {
    if (!Array.isArray(value.projection || [])) throw new Error("Invalid Claude recovery projection");
    for (const change of value.projection || []) if (change.file !== path.join(runtime.defaultSlot.dir, "settings.json")) throw new Error("Invalid Claude recovery configuration path");
    for (const change of value.projection || []) await withFileLock(change.file, async () => {
      if (change.file !== path.join(runtime.defaultSlot.dir, "settings.json")) throw new Error("Invalid Claude recovery configuration path");
      await runtime.validateSlot(runtime.defaultSlot, { create: false });
      await require("./agy-fs").privateFile(change.file);
      const current = await fs.readFile(change.file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (native.hash(current) === change.beforeHash) return;
      if (native.hash(current) !== change.afterHash) throw new Error("Claude settings changed after the interrupted switch; recovery kept them");
      if (change.beforeExists) {
        const backupRoot = path.join(path.dirname(runtime.root), "backups", "claude");
        const accountBackups = path.join(runtime.root, "projection-backups");
        if (![backupRoot, accountBackups].includes(path.dirname(change.backup || "")) || !/^[\w.-]+\.bak$/.test(path.basename(change.backup || ""))) throw new Error("Invalid Claude recovery backup path");
        await require("./agy-fs").privateFile(change.backup);
        const before = await fs.readFile(change.backup, "utf8");
        if (native.hash(before) !== change.beforeHash) throw new Error("Claude recovery backup changed; configuration was kept");
        if (native.hash(await fs.readFile(change.file, "utf8")) !== change.afterHash) throw new Error("Claude settings changed during recovery; they were kept");
        await writeFileAtomic(change.file, before, { mode: 0o600 });
      } else await fs.rm(change.file, { force: true });
    });
  };
  const finish = async value => {
    const source = decoded(value.source), dest = decoded(value.dest);
    const destination = await runtime.credentials.read(dest);
    if (native.hash(native.accountPart(destination)) !== value.sourceHash) throw new Error("Claude switch recovery found a changed destination; credentials were kept");
    for (const change of value.projection || []) {
      if (change.file !== path.join(runtime.defaultSlot.dir, "settings.json")) throw new Error("Invalid Claude recovery configuration path");
      await require("./agy-fs").privateFile(change.file);
      const text = await fs.readFile(change.file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (native.hash(text) !== change.afterHash) throw new Error("Claude settings changed after login switched; recovery preserved them");
    }
    await runtime.writeProfile(dest, profileWith(await runtime.readProfile(dest), value.oauthAccount));
    const original = await runtime.credentials.read(source);
    const fingerprint = native.hash(native.accountPart(original));
    if (fingerprint === value.sourceHash) await runtime.writeVerified(source, native.sharedPart(original));
    else if (Object.keys(native.accountPart(original)).length) throw new Error("Claude switch recovery found a new source login; it was kept");
    if (source.default) await runtime.writeProfile(source, profileWith(await runtime.readProfile(source), null));
    await fs.rm(journalFile, { force: true });
  };
  const recoverLocked = async () => {
    const value = await native.readJson(journalFile);
    if (!value) return { recovered: false };
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.sourceHash || "") || !/^[a-f0-9]{64}$/.test(value.destBeforeHash || "") || !native.identity({ oauthAccount: value.oauthAccount })) throw new Error("Claude recovery journal is invalid; it was kept");
    if (value.source === value.dest || (value.source !== "default" && value.dest !== "default") || !Array.isArray(value.projection || [])) throw new Error("Claude recovery slots are invalid; logins were kept");
    const source = decoded(value.source), dest = decoded(value.dest);
    return native.withSlotLocks(runtime, [source, dest], async () => {
      const current = native.hash(native.accountPart(await runtime.credentials.read(dest)));
      if (current === value.sourceHash) { await finish(value); return { recovered: true }; }
      if (current === value.destBeforeHash && native.hash(native.accountPart(await runtime.credentials.read(source))) === value.sourceHash) {
        await restoreProjection(value);
        await fs.rm(journalFile, { force: true }); return { recovered: true, committed: false };
      }
      throw new Error("Claude credentials changed during recovery; the journal and native logins were kept");
    });
  };
  const relocate = async (id, { isolated = false, replaceLogin = false, prepare, apply, rollback } = {}) => withFileLock(lockFile, async () => {
    await recoverLocked();
    const store = await load(), target = store.accounts[id];
    if (!target) throw new Error("Claude account not found on this device; sign in first");
    const account = runtime.slot(target.localId), live = runtime.defaultSlot;
    const [liveSecret, liveProfile] = await Promise.all([runtime.credentials.read(live), runtime.readProfile(live)]);
    const liveOwner = native.owner(liveSecret, liveProfile);
    if (isolated && liveOwner?.id !== id) return { currentAccountId: liveOwner?.id || null, isolated: true, changed: false };
    if (!isolated && liveOwner?.id === id && !replaceLogin) { return native.withSlotLocks(runtime, [live], async () => { const projection = await prepare?.() || []; try { await apply?.(); } catch (error) { await rollback?.(); await restoreProjection({ projection }); throw error; } return { currentAccountId: id, changed: false }; }); }
    const source = isolated ? live : account, dest = isolated ? account : live;
    const priorSecret = isolated ? await runtime.credentials.read(account) : liveSecret;
    const priorProfile = isolated ? await runtime.readProfile(account) : liveProfile;
    const priorOwner = native.owner(priorSecret, priorProfile);
    let prior = priorOwner && priorOwner.id !== id ? store.accounts[priorOwner.id] : null;
    if (priorOwner && priorOwner.id !== id && !prior) prior = { localId: newId(), email: priorOwner.email, orgName: priorOwner.orgName, authenticatedAt: Date.now() };
    const priorSlot = prior ? runtime.slot(prior.localId) : null;
    const backupId = newId(), backup = runtime.backupSlot(prior?.localId || target.localId, backupId);
    const locks = [source, dest, backup, ...(priorSlot ? [priorSlot] : [])];
    return native.withSlotLocks(runtime, locks, async () => {
      if (native.hash(await runtime.credentials.read(live)) !== native.hash(liveSecret)) throw new Error("Claude changed its sign-in during switching; try again");
      const sourceSecret = await runtime.credentials.read(source), sourceProfile = await runtime.readProfile(source);
      if (!native.validLogin(sourceSecret) || native.owner(sourceSecret, sourceProfile)?.id !== id) throw new Error("This Claude account's sign-in is expired or belongs to another account; sign in again");
      const destinationSecret = await runtime.credentials.read(dest);
      if (native.hash(destinationSecret) !== native.hash(priorSecret)) throw new Error("Claude changed the destination sign-in; try again");
      // Park the current login in its own native slot. An independent login
      // already there gets a native backup before replacement.
      if (priorSlot) {
        const parked = await runtime.credentials.read(priorSlot);
        if (Object.keys(native.accountPart(parked)).length && native.hash(native.accountPart(parked)) !== native.hash(native.accountPart(priorSecret))) {
          await runtime.writeVerified(backup, parked);
          await runtime.writeProfile(backup, await runtime.readProfile(priorSlot));
          prior.backups = [...(prior.backups || []), backupId];
        }
        await runtime.writeVerified(priorSlot, native.merge(parked, priorSecret));
        await runtime.writeProfile(priorSlot, profileWith(await runtime.readProfile(priorSlot), priorProfile.oauthAccount));
        store.accounts[priorOwner.id] = prior;
        await save(store);
      } else if (Object.keys(native.accountPart(destinationSecret)).length && native.hash(native.accountPart(destinationSecret)) !== native.hash(native.accountPart(sourceSecret))) {
        await runtime.writeVerified(backup, destinationSecret);
        await runtime.writeProfile(backup, priorProfile);
        target.backups = [...(target.backups || []), backupId]; await save(store);
      }
      const value = { version: 1, source: encoded(source), dest: encoded(dest), sourceHash: native.hash(native.accountPart(sourceSecret)), destBeforeHash: native.hash(native.accountPart(destinationSecret)), oauthAccount: sourceProfile.oauthAccount, createdAt: Date.now(), projection: await prepare?.() || [] };
      await journal(value);
      let applied = false;
      try {
        await apply?.(); applied = Boolean(apply);
        if (native.hash(await runtime.credentials.read(source)) !== native.hash(sourceSecret) || native.hash(await runtime.credentials.read(dest)) !== native.hash(destinationSecret)) throw new Error("Claude changed its sign-in data; switch canceled");
        await runtime.writeVerified(dest, native.merge(destinationSecret, sourceSecret));
      } catch (error) {
        // An uncertain write retains the journal. The next recovery checks
        // fingerprints instead of overwriting a newer login.
        const committed = native.hash(native.accountPart(await runtime.credentials.read(dest))) === value.sourceHash;
        if (!committed) { if (applied) await rollback?.(); await restoreProjection(value); await fs.rm(journalFile, { force: true }); throw error; }
      }
      const warnings = [];
      try { await finish(value); } catch { warnings.push("Claude login switched; finish recovery before another switch"); }
      return { currentAccountId: isolated ? null : id, isolated, changed: true, warnings, recoveryPath: warnings.length ? journalFile : null };
    });
  });
  return { switchAccount: (id, options) => relocate(id, options), isolate: id => relocate(id, { isolated: true }), recover: () => withFileLock(lockFile, recoverLocked), journalFile };
}
module.exports = { createSwitcher, profileWith };
