// Herdr Ranch: Agents, Files and Spaces are copies of Herdr's own mods. When a Herdr update
// changes the one a copy came from, say so once, so the copy can take in Herdr's changes
// (each mod's RECIPE.md: "After a Herdr update"). Shared: shared/upstream.js, copied to each.
import { exec, appHome, notify, checking } from "herdr";

// Herdr's main.js the copy was made from: its name, Herdr version and sha-256.
export async function checkUpstream(name, version, sha) {
  if (checking()) return;
  const file = `${appHome()}/mods/${name}/main.js`;
  const r = await exec("sh", ["-c", 'shasum -a 256 "$1" 2>/dev/null || sha256sum "$1"', "sh", file]).catch(() => null);
  const now = r?.code === 0 ? r.stdout.trim().split(/\s+/)[0] : null;
  if (!now || now === sha) return;
  const key = `upstream.seen.${name}`;
  try { if (localStorage.getItem(key) === now) return; localStorage.setItem(key, now); } catch { /* say it each start */ }
  notify(upstreamNote(name, version));
}

export function upstreamNote(name, version) {
  return {
    title: `Herdr changed its ${name} mod`,
    body: `Herdr Ranch's ${name[0].toUpperCase()}${name.slice(1)} is a copy of Herdr ${version}'s. Run scripts/upstream-diff.sh ${name} in the Herdr Ranch folder to see what changed, then take it in (RECIPE.md).`,
    level: "warning",
    timeout: 30000,
  };
}
