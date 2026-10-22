"use strict";

// EasyCLIProxyAPI's bounded recovery policy, adapted to the Node server.
// Manual lifecycle actions advance a generation; delayed retries can never
// undo a stop. Success retains the rolling budget to bound crash loops.
function createRecovery({ check, recover, now = Date.now, delays = [2000, 5000, 15000], windowMs = 300000, schedule = setTimeout, cancel = clearTimeout }) {
  let generation = 0;
  let armed = false;
  let timer = null;
  let failures = 0;
  let attempts = [];
  let pending = false;
  let state = "idle";
  let nextAttemptAt = null;
  const snapshot = () => ({ state, armed, attempts: attempts.length, nextAttemptAt });
  const disarm = () => { generation++; armed = false; cancel(timer); timer = null; state = "idle"; nextAttemptAt = null; failures = 0; };
  const arm = () => { disarm(); armed = true; state = "watching"; };
  async function tick() {
    if (!armed || pending || timer || state === "recovering") return;
    const epoch = generation;
    pending = true;
    try {
      const healthy = await check();
      if (!armed || epoch !== generation) return;
      if (healthy) { failures = 0; state = "watching"; return; }
      if (++failures < 2) return;
      attempts = attempts.filter(at => now() - at < windowMs);
      if (attempts.length >= delays.length) { state = "exhausted"; return; }
      const delay = delays[attempts.length];
      nextAttemptAt = now() + delay; state = "waiting";
      timer = schedule(async () => {
        timer = null;
        if (!armed || epoch !== generation) return;
        state = "recovering"; nextAttemptAt = null; attempts.push(now());
        try { await recover(() => armed && epoch === generation); }
        catch { /* Retry budget, never private upstream errors, is public. */ }
        if (armed && epoch === generation) { failures = 0; state = "watching"; }
      }, delay);
      timer.unref?.();
    } finally { pending = false; }
  }
  return { arm, disarm, tick, snapshot };
}
module.exports = { createRecovery };
