const assert = require("node:assert/strict");
async function checkRotation() {
  const { Rotation } = await import("../assets/rotation.js");
  let current = 0;
  let state;
  let timer;
  let advances = 0;
  const rotation = new Rotation({
    next: () => advances++, changed: value => { state = value; },
    schedule: callback => { timer = callback; return ++current; },
    cancel: () => { timer = null; },
  });
  rotation.start();
  assert(state.running && state.enabled);
  assert.equal(state.delay, 12000);
  timer();
  assert.equal(advances, 1);
  rotation.hold("hover", true);
  assert.equal(timer, null);
  assert(!state.running && state.enabled);
  rotation.hold("hidden", true);
  rotation.hold("hover", false);
  assert.equal(timer, null, "hidden pages stay paused after pointer leaves");
  rotation.hold("hidden", false);
  assert(state.running);
  rotation.stop();
  assert(!state.running && !state.enabled);
  rotation.hold("hover", false);
  assert.equal(timer, null, "manual pause persists through temporary hold changes");
  rotation.start();
  timer();
  assert.equal(advances, 2);
  rotation.stop();
  assert.equal(timer, null);
}
module.exports = { checkRotation };
