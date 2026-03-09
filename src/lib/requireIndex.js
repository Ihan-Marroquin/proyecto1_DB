const REJECT_NO_INDEX = process.env.REJECT_NO_INDEX === '1' || process.env.REJECT_NO_INDEX === 'true';

function hasCollScan(stage) {
  if (!stage) return false;
  if (stage.stage === 'COLLSCAN') return true;
  if (stage.inputStage) return hasCollScan(stage.inputStage);
  if (stage.inputStages) return stage.inputStages.some(s => hasCollScan(s));
  return false;
}

async function requireIndex(collection, query = {}, options = {}) {
  if (!REJECT_NO_INDEX) return;
  const cursor = collection.find(query, {
    ...options,
    projection: options.projection
  });
  const explain = await cursor.explain('executionStats');
  const exec = explain.executionStats || explain.queryPlanner;
  const stage = exec.executionStages || exec.winningPlan;
  if (hasCollScan(stage)) {
    const err = new Error('Query rejected: no index used (COLLSCAN). Set indexes or disable REJECT_NO_INDEX.');
    err.code = 'NO_INDEX';
    err.explain = explain;
    throw err;
  }
}

module.exports = { requireIndex, REJECT_NO_INDEX, hasCollScan };
