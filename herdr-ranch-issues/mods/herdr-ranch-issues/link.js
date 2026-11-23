// Herdr Ranch: Ctrl/Cmd-click on a GitHub issue link in a terminal
// (https://github.com/<owner>/<repo>/issues/<n>) opens that issue's page here, of any
// repository gh can read. A pull request behind an /issues/ link, a repository gh can't read,
// gh signed out or no shown space: the link goes on to the browser.
import { exec, spaces } from "herdr";
import { MODS, openIn, parseGithubLink } from "./xref.js";

export { parseGithubLink };

// The space of the clicked terminal, only when it is the shown one (the list follows that space).
export function spaceOf(source) {
  const all = spaces() ?? [];
  const space = source?.space ? all.find((s) => s.id === source.space) : all.find((s) => s.active);
  return space?.active ? space : null;
}

export async function handleLink({ link, source }) {
  const g = link?.kind === "url" ? parseGithubLink(link.url ?? link.raw) : null;
  if (g?.kind !== "issue") return "pass";
  const space = spaceOf(source);
  if (!space) return "pass";
  // gh signed in and allowed to read it, and an issue (GitHub's issues API answers for pull requests too).
  const r = await exec("gh", ["api", `repos/${g.github}/issues/${g.number}`, "--jq", ".pull_request == null"], { on: space.machine ?? undefined, timeout: 15000 }).catch(() => null);
  if (r?.code !== 0 || r.stdout.trim() !== "true") return "pass";
  openIn(MODS.issues, { key: `#${g.number}`, github: g.github, url: `https://github.com/${g.github}/issues/${g.number}` });
  return "handled";
}
