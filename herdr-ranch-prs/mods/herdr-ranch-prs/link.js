// Herdr Ranch: Ctrl/Cmd-click on a GitHub pull request link in a terminal
// (https://github.com/<owner>/<repo>/pull/<n>, also its /files, /commits or #discussion links)
// opens that pull request's page here, when it is of the shown space's repository and gh can
// read it. Anything else (another repository, gh signed out, no space) goes on to the browser.
import { exec, spaces, shared } from "herdr";
import { MODS, openIn, parseGithubLink, sameRepo } from "./xref.js";

export { parseGithubLink };

// The space of the clicked terminal, only when it is the shown one (the list follows that space).
export function spaceOf(source) {
  const all = spaces() ?? [];
  const space = source?.space ? all.find((s) => s.id === source.space) : all.find((s) => s.active);
  return space?.active ? space : null;
}

// The space's GitHub repository as the list finds it (links.js context(), which this handler
// doesn't import: it brings the UI kit along): its Link space entry, else that of another space
// on the same repository, else the folder's remote. null when there's none.
async function githubOf(space) {
  const links = shared("space-links") ?? {};
  if (links[space.id]?.github) return links[space.id].github;
  if (!space.folder) return null;
  const on = space.machine ?? undefined;
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: space.folder, on }).catch(() => null);
  if (common?.code !== 0) return null;
  const main = common.stdout.trim().replace(/\/\.git\/?$/, "");
  const link = links[space.id] ?? Object.values(links).find((l) => l?.main === main && (l.on ?? null) === (space.machine ?? null));
  if (link?.github) return link.github;
  const r = await exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: main, on, timeout: 15000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() || null : null;
}

export async function handleLink({ link, source }) {
  const g = link?.kind === "url" ? parseGithubLink(link.url ?? link.raw) : null;
  if (g?.kind !== "pr") return "pass";
  const space = spaceOf(source);
  if (!space) return "pass";
  const github = await githubOf(space).catch(() => null);
  if (!sameRepo(github, g.github)) return "pass";
  // gh signed in, and allowed to read this repository, where the list runs it.
  const r = await exec("gh", ["api", `repos/${g.github}/pulls/${g.number}`, "--jq", ".number"], { on: space.machine ?? undefined, timeout: 15000 }).catch(() => null);
  if (r?.code !== 0 || Number(r.stdout.trim()) !== g.number) return "pass";
  openIn(MODS.prs, { number: g.number, github });
  return "handled";
}
