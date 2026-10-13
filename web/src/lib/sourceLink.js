// AGPL corresponding source for this deployment. The commit is stamped at
// build time (vite.config.js). Absent under the Node test runner, the link
// falls back to the repository root rather than a dangling /commit/.

export const SOURCE_REPO = "https://github.com/rkoechel/opentakeoff";

export function sourceCommit() {
  const sha = typeof __OT_SOURCE_COMMIT__ !== "undefined" ? String(__OT_SOURCE_COMMIT__ || "") : "";
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : "";
}

export function sourceHref() {
  const sha = sourceCommit();
  return sha ? `${SOURCE_REPO}/commit/${sha}` : SOURCE_REPO;
}

export function sourceLabel() {
  const sha = sourceCommit();
  return sha ? `Source ${sha.slice(0, 7)}` : "Source";
}
