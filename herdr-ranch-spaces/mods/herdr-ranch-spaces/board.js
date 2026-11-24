// The Worktrees board's data: every checkout of every repository you work in, grouped by the
// ticket its branch names (one ticket can span several repositories), with what each one needs:
// work to commit or push, a pull request, or nothing (ready to clean up). The pure parts are
// tested in tests/spaces.test.mjs; board-dialog.js draws it.

import { exec, spaces, panes, home } from "herdr";
import { place, probe, worktrees, worktreesWithWork, repoName, mainOf } from "./git.js";
import { linkOf, detectGithub } from "./links.js";
import { accountOf, ghAs, ghUserOf } from "./accounts.js";

const DAY = 86400;
export const STALE_DAYS = 14;
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");

// The ticket a branch is for: a Jira or Linear key ("agent/plan-TASS-14294-xss" -> "TASS-14294"),
// a GitHub issue ("issue-12-fix" -> "#12"), else null.
export function keyOf(name) {
  const s = name ?? "";
  const jira = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![0-9])/.exec(s);
  if (jira) return jira[1];
  const gh = /(?:^|\/)issue-(\d+)(?![0-9])/.exec(s);
  return gh ? `#${gh[1]}` : null;
}

// `git for-each-ref --format=%(refname:short)%09%(upstream:short)%09%(upstream:track) refs/heads`
// as Map(branch -> { upstream, gone, ahead, behind }).
export function parseHeads(text) {
  const out = new Map();
  for (const line of (text ?? "").split("\n")) {
    if (!line) continue;
    const [name, upstream, track = ""] = line.split("\t");
    out.set(name, {
      upstream: upstream || null, gone: track.includes("gone"),
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
    });
  }
  return out;
}

// The branch name an upstream points at ("origin/TASS-1" -> "TASS-1").
export const upstreamBranch = (u) => (u ? u.replace(/^[^/]+\//, "") : null);

// What a checkout is: { ready, reason, flags: [text...], tone }. `c`: a checkout as read by
// readRepo: { isMain, branch, changes, unpushed, upstream, gone, own, head, at, pr, defaultShort }.
// Ready to clean up: nothing uncommitted, and its commits are safe elsewhere (merged into the
// default branch, its pull request merged at this commit, or a branch with no commits of its own
// that's been left a day). Main checkouts are never ready.
export function judge(c, now = Date.now() / 1000) {
  const flags = [];
  const idle = c.at ? Math.floor((now - c.at) / DAY) : null;
  const pushedTo = upstreamBranch(c.upstream);
  if (c.isMain && c.branch && c.defaultShort && c.branch !== c.defaultShort) flags.push(`The main checkout is on ${c.branch}, not ${c.defaultShort}`);
  if (!c.branch) flags.push("Detached: no branch points at it");
  if (pushedTo && c.branch && pushedTo !== c.branch) flags.push(`Pushes to ${c.upstream}, not ${c.branch}`);
  if (c.gone && c.unpushed > 0) flags.push(`Its branch was deleted on the remote; ${c.unpushed} commit${c.unpushed === 1 ? " is" : "s are"} only here`);
  let ready = false, reason = "";
  if (!c.isMain && c.branch && c.changes === 0) {
    if (c.pr?.state === "MERGED" && (c.pr.headRefOid === c.head || c.own === 0)) { ready = true; reason = `PR #${c.pr.number} merged`; }
    else if (c.own === 0 && (c.upstream || c.pr)) { ready = true; reason = `Merged into ${c.defaultShort ?? "the default branch"}`; }
    else if (c.own === 0 && idle != null && idle >= 1) { ready = true; reason = `No commits of its own, idle ${idle}d`; }
    else if (c.gone && c.unpushed === 0) { ready = true; reason = "Its branch was deleted on the remote, and nothing is only here"; }
    else if (c.pr?.state === "CLOSED" && c.unpushed === 0) { ready = true; reason = `PR #${c.pr.number} closed without merging; its commits are on the remote`; }
  }
  if (!ready && !c.isMain && idle != null && idle >= STALE_DAYS) flags.push(`Untouched for ${idle} days`);
  const tone = c.changes > 0 || flags.length ? "warn" : ready ? "ready" : "ok";
  return { ready, reason, flags, tone, idle };
}

// Checkouts grouped by ticket, newest activity first: [{ key, checkouts, at }]. A branch without
// a key is its own group (key: the branch). Main checkouts on their default branch are left out.
export function groupByTicket(checkouts) {
  const groups = new Map();
  for (const c of checkouts) {
    if (c.isMain && (!c.branch || c.branch === (c.defaultShort ?? (["main", "master"].includes(c.branch) ? c.branch : null)))) continue;
    const key = keyOf(c.branch) ?? keyOf(upstreamBranch(c.upstream)) ?? c.branch ?? c.path.split("/").pop();
    const g = groups.get(key) ?? { key, ticket: Boolean(keyOf(c.branch) ?? keyOf(upstreamBranch(c.upstream))), checkouts: [], at: 0 };
    g.checkouts.push(c);
    g.at = Math.max(g.at, c.at ?? 0);
    groups.set(key, g);
  }
  for (const g of groups.values()) g.checkouts.sort((a, b) => a.repo.localeCompare(b.repo));
  return [...groups.values()].sort((a, b) => b.at - a.at);
}

// `git worktree prune --dry-run --verbose` lines: the registrations whose folder is gone.
export const parsePrunable = (text) => (text ?? "").split("\n").map((l) => l.trim()).filter((l) => /^Removing /.test(l));

// ---- reading -------------------------------------------------------------------------------

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on }).catch(() => null);
  return r?.code === 0 ? r.stdout : null;
}

// Every repository to show: the ones your spaces are in (any machine), plus those with worktrees
// under ~/.herdr/worktrees here. [{ main, on, name, common }]
export async function findRepos() {
  const ps = panes(), seen = new Map();
  const add = (common, on) => {
    const k = JSON.stringify([on ?? null, common]);
    if (!seen.has(k)) seen.set(k, { common, main: mainOf(common), on: on ?? null, name: repoName(common) });
  };
  await Promise.all(spaces().map(async (s) => {
    const at = place(s, ps);
    const g = at ? await probe(at, s.machine ?? null).catch(() => null) : null;
    if (g) add(JSON.parse(g.repo)[1], s.machine ?? null);
  }));
  const dir = `${home()}/.herdr/worktrees`;
  const r = await exec("sh", ["-c", 'for d in "$1"/*/*/; do [ -e "$d.git" ] && git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; done; true', "sh", dir]).catch(() => null);
  for (const common of (r?.stdout ?? "").split("\n").filter(Boolean)) add(common, null);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// The default branch as a ref and a short name: origin/HEAD, else origin/main or master, else main or master.
async function defaultBranch(main, on) {
  const head = (await git(main, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], on))?.trim();
  if (head) return { ref: head, short: upstreamBranch(head) };
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (await git(main, ["rev-parse", "-q", "--verify", `${ref}^{commit}`], on)) return { ref, short: upstreamBranch(ref) };
  }
  return { ref: null, short: null };
}

// The repository's pull requests (most recent 200, any state) by head branch, as the
// repository's account; empty when gh can't say.
async function pullRequests(repo) {
  const slug = await detectGithub(repo).catch(() => null);
  if (!slug) return new Map();
  const acct = accountOf({ id: null }, { main: repo.main, on: repo.on });
  const r = await ghAs(ghUserOf(acct), ["pr", "list", "-R", slug, "--state", "all", "-L", "200", "--json", "number,state,headRefName,headRefOid,url,title"], { on: repo.on }).catch(() => null);
  const out = new Map();
  if (r?.code !== 0) return out;
  try {
    // Newest first: the first one per branch wins.
    for (const p of JSON.parse(r.stdout)) if (!out.has(p.headRefName)) out.set(p.headRefName, p);
  } catch { /* not JSON */ }
  return out;
}

// One repository's checkouts, each with everything judge() needs plus its space.
// `prev`: the last read's checkouts, so unchanged work isn't read again.
export async function readRepo(repo, { prs = true } = {}) {
  const { main, on } = repo;
  const [list, headsText, def, pr, prune] = await Promise.all([
    // Reading each checkout's work can be slow in a big repository: without it, the list still shows.
    worktreesWithWork(main, on).catch(() => worktrees(main, on)),
    git(main, ["for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)", "refs/heads"], on),
    defaultBranch(main, on),
    prs ? pullRequests(repo) : Promise.resolve(new Map()),
    git(main, ["worktree", "prune", "--dry-run", "--verbose"], on),
  ]);
  const heads = parseHeads(headsText);
  const ps = panes(), sp = spaces().filter((s) => (s.machine ?? null) === (on ?? null));
  const checkouts = await Promise.all(list.map(async (c) => {
    const h = c.branch ? heads.get(c.branch) : null;
    const [head, own, at] = await Promise.all([
      git(c.path, ["rev-parse", "HEAD"], on),
      def.ref && c.branch ? git(main, ["rev-list", "--count", `${def.ref}..refs/heads/${c.branch}`], on) : null,
      git(c.path, ["log", "-g", "-1", "--format=%ct", "HEAD"], on).then((t) => t?.trim() || git(c.path, ["log", "-1", "--format=%ct"], on)),
    ]);
    // The space shown there: the deepest checkout that holds the space's place is this one.
    const space = sp.find((s) => { const at2 = place(s, ps) ?? ""; return inside(at2, c.path) && !list.some((d) => d !== c && d.path.length > c.path.length && inside(at2, d.path)); });
    const out = {
      repo: repo.name, main, on, path: c.path, branch: c.branch, isMain: c.main, locked: c.locked,
      changes: c.changes ?? null, unpushed: c.unpushed ?? null,
      upstream: h?.upstream ?? null, gone: h?.gone ?? false, ahead: h?.ahead ?? 0, behind: h?.behind ?? 0,
      head: head?.trim() ?? null, own: own == null ? null : Number(own.trim()), at: Number(String(at ?? "").trim()) || null,
      pr: c.branch ? pr.get(c.branch) ?? null : null, defaultShort: def.short, defaultRef: def.ref,
      space: space?.id ?? null,
    };
    return { ...out, judged: judge(out) };
  }));
  return { ...repo, checkouts, prunable: parsePrunable(prune), defaultRef: def.ref, defaultShort: def.short };
}

// Empty folders under ~/.herdr/worktrees (a repository's folder whose worktrees are all gone),
// and folders there that aren't a checkout at all (no .git: what a deleted worktree can leave).
export async function leftovers(known) {
  const dir = `${home()}/.herdr/worktrees`;
  const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null || exit 0; for d in */ */*/; do [ -d "$d" ] || continue; [ -e "$d.git" ] && printf "%s\\tgit\\n" "${d%/}" || printf "%s\\n" "${d%/}"; done', "sh", dir]).catch(() => null);
  const lines = (r?.stdout ?? "").split("\n").filter(Boolean).map((l) => l.split("\t"));
  const rel = lines.map(([p]) => p), checkout = new Set(lines.filter(([, g]) => g).map(([p]) => p));
  const paths = new Set(known);
  const kids = (p) => rel.filter((x) => x.startsWith(p + "/"));
  const empty = rel.filter((p) => !p.includes("/") && kids(p).length === 0).map((p) => `${dir}/${p}`);
  const strays = rel.filter((p) => p.includes("/") && !checkout.has(p) && !paths.has(`${dir}/${p}`)).map((p) => `${dir}/${p}`);
  return { dir, empty, strays };
}

// ---- acting --------------------------------------------------------------------------------

// What Clean up does to a ready checkout, in words, for the confirm step.
export function cleanupPlan(c, spaceName) {
  return [
    spaceName ? `close the space ${spaceName}` : null,
    `delete ${c.path.replace(home(), "~")}`,
    `delete the branch ${c.branch}`,
  ].filter(Boolean);
}

// Remove a ready checkout and its branch (its space is closed by the caller first). The branch goes
// with -d when git agrees it's merged, else -D: judge() only calls a checkout ready when its
// commits are safe (merged, its PR merged at this commit, or none of its own).
export async function cleanUp(c) {
  const rm = await exec("git", ["worktree", "remove", c.path], { cwd: c.main, on: c.on, timeout: 600_000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
  if (rm.code !== 0) throw new Error((rm.stderr || "git worktree remove failed").trim());
  const soft = await exec("git", ["branch", "-d", c.branch], { cwd: c.main, on: c.on }).catch(() => ({ code: 1 }));
  if (soft.code !== 0) {
    const hard = await exec("git", ["branch", "-D", c.branch], { cwd: c.main, on: c.on }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (hard.code !== 0) throw new Error(`Deleted the worktree, but not the branch: ${(hard.stderr || "").trim()}`);
  }
  // Its repository's folder under ~/.herdr/worktrees, if that's now empty.
  const parent = c.path.replace(/\/[^/]+$/, "");
  if (parent.endsWith(`/.herdr/worktrees/${parent.split("/").pop()}`)) await exec("rmdir", [parent], { on: c.on }).catch(() => null);
}

// A new worktree for a ticket in each chosen repository, all on one branch, from each
// repository's default branch (its existing branch when it has one). Returns [{ repo, path, error }].
export async function startTicket(branch, repos, homeDir) {
  return Promise.all(repos.map(async (repo) => {
    const path = `${homeDir}/.herdr/worktrees/${repo.name}/${branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}`;
    try {
      const local = await git(repo.main, ["show-ref", "--verify", "-q", `refs/heads/${branch}`], repo.on);
      const remote = local == null ? await git(repo.main, ["show-ref", "--verify", "-q", `refs/remotes/origin/${branch}`], repo.on) : null;
      const def = await defaultBranch(repo.main, repo.on);
      const args = local != null ? ["worktree", "add", path, branch]
        : remote != null ? ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`]
        : ["worktree", "add", "--no-track", "-b", branch, path, def.ref ?? "HEAD"];
      const r = await exec("git", args, { cwd: repo.main, on: repo.on, timeout: 600_000 });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || "git worktree add failed").trim());
      return { repo, path, error: null };
    } catch (e) { return { repo, path, error: String(e?.message ?? e) }; }
  }));
}

// The Jira (or Linear) source to look titles up with: the first linked repository's.
export function titleSource(repos) {
  for (const r of repos) {
    const l = linkOf({ id: null }, { main: r.main, on: r.on });
    if (l?.jira?.site && l.issues !== "github" && l.issues !== "linear") return { kind: "jira", site: l.jira.site, project: l.jira.key };
    if (l?.issues === "linear" && l.linear?.teamId) return { kind: "linear", team: l.linear.teamId };
  }
  return null;
}
