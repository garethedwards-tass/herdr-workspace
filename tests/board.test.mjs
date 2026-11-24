// The Worktrees board's data: ticket keys from branches, branch tracking, when a checkout is
// ready to clean up or needs a look, and grouping by ticket across repositories.
// Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyOf, parseHeads, upstreamBranch, judge, groupByTicket, parsePrunable, agentsFor, ticketDone } from "../herdr-ranch-spaces/mods/herdr-ranch-spaces/board.js";

const NOW = 1_800_000_000, DAY = 86400;
const base = { isMain: false, branch: "TASS-1", changes: 0, unpushed: 0, upstream: "origin/TASS-1", gone: false, own: 2, head: "abc", at: NOW - DAY, pr: null, defaultShort: "main" };
const c = (o) => ({ ...base, ...o });

test("keyOf: Jira keys anywhere in a branch, GitHub issue branches, else null", () => {
  assert.equal(keyOf("TASS-10497"), "TASS-10497");
  assert.equal(keyOf("agent/plan-TASS-14294-reflected-xss"), "TASS-14294");
  assert.equal(keyOf("TASS-15469-on-demand-defaults"), "TASS-15469");
  assert.equal(keyOf("issue-12-fix-login"), "#12");
  assert.equal(keyOf("feat/issue-7"), "#7");
  assert.equal(keyOf("main"), null);
  assert.equal(keyOf("01.2026.07.200"), null);
  assert.equal(keyOf("tass-12-lowercase"), null);
  assert.equal(keyOf(null), null);
});

test("parseHeads: upstream, gone, ahead and behind per branch", () => {
  const m = parseHeads("main\torigin/main\t\nTASS-1\torigin/TASS-1\t[ahead 2, behind 1]\nold\torigin/old\t[gone]\nlocal\t\t\n");
  assert.deepEqual(m.get("TASS-1"), { upstream: "origin/TASS-1", gone: false, ahead: 2, behind: 1 });
  assert.equal(m.get("old").gone, true);
  assert.equal(m.get("local").upstream, null);
  assert.equal(upstreamBranch("origin/feature/x"), "feature/x");
  assert.equal(upstreamBranch(null), null);
});

test("judge: ready when its commits are safe and nothing is uncommitted", () => {
  assert.equal(judge(c({ pr: { number: 5, state: "MERGED", headRefOid: "abc" } }), NOW).reason, "PR #5 merged");
  assert.equal(judge(c({ own: 0 }), NOW).reason, "Merged into main");
  assert.equal(judge(c({ own: 0, upstream: null, at: NOW - 8 * DAY }), NOW).reason, "No commits of its own, idle 8d");
  assert.equal(judge(c({ gone: true, unpushed: 0 }), NOW).ready, true);
  assert.equal(judge(c({ pr: { number: 6, state: "CLOSED" } }), NOW).ready, true);
});

test("judge: not ready with uncommitted files, later commits, a fresh empty branch, or as the main checkout", () => {
  assert.equal(judge(c({ own: 0, changes: 1 }), NOW).ready, false);
  assert.equal(judge(c({ pr: { number: 5, state: "MERGED", headRefOid: "older" } }), NOW).ready, false);
  assert.equal(judge(c({ own: 0, upstream: null, at: NOW - 3600 }), NOW).ready, false);
  assert.equal(judge(c({ isMain: true, own: 0 }), NOW).ready, false);
  assert.equal(judge(c({ branch: null, own: 0 }), NOW).ready, false);
  assert.equal(judge(c({ gone: true, unpushed: 2 }), NOW).ready, false);
});

test("judge: flags what needs a look", () => {
  assert.deepEqual(judge(c({ branch: "agent/plan-TASS-1-x", upstream: "origin/TASS-1" }), NOW).flags, ["Pushes to origin/TASS-1, not agent/plan-TASS-1-x"]);
  assert.deepEqual(judge(c({ isMain: true, branch: "TASS-9", upstream: "origin/TASS-9" }), NOW).flags, ["The main checkout is on TASS-9, not main"]);
  assert.match(judge(c({ gone: true, unpushed: 2 }), NOW).flags[0], /deleted on the remote; 2 commits are only here/);
  assert.deepEqual(judge(c({ at: NOW - 20 * DAY }), NOW).flags, ["Untouched for 20 days"]);
  assert.deepEqual(judge(c({ own: 0, at: NOW - 20 * DAY }), NOW).flags, []); // ready, so not stale
  assert.equal(judge(c({ changes: 3 }), NOW).tone, "warn");
  assert.equal(judge(c({}), NOW).tone, "ok");
});

test("groupByTicket: one ticket across repositories, keyless branches alone, main checkouts on main left out", () => {
  const g = groupByTicket([
    c({ repo: "tassweb", path: "/w/tassweb/TASS-1", at: 10 }),
    c({ repo: "kiosk", path: "/w/kiosk/TASS-1", at: 20 }),
    c({ repo: "tassweb", path: "/w/tassweb/agent", branch: "agent/plan-TASS-2-x", upstream: "origin/TASS-2", at: 30 }),
    c({ repo: "tassweb", path: "/w/tassweb/spike", branch: "spike", upstream: null, at: 5 }),
    c({ repo: "tassweb", path: "/src/tassweb", isMain: true, branch: "main", at: 99 }),
    c({ repo: "kiosk", path: "/src/kiosk", isMain: true, branch: "TASS-3", upstream: null, at: 1 }),
  ]);
  assert.deepEqual(g.map((x) => x.key), ["TASS-2", "TASS-1", "spike", "TASS-3"]);
  assert.deepEqual(g[1].checkouts.map((x) => x.repo), ["kiosk", "tassweb"]);
  assert.equal(g[2].ticket, false);
  assert.equal(g[1].ticket, true);
});

test("parsePrunable: the registrations git would prune", () => {
  assert.deepEqual(parsePrunable("Removing worktrees/x: gitdir file points to non-existent location\n\n"), ["Removing worktrees/x: gitdir file points to non-existent location"]);
  assert.deepEqual(parsePrunable(""), []);
});

test("agentsFor: agents in the checkout's space, or working in its folder from anywhere; most urgent first", () => {
  const all = [
    { path: "/src/web", on: null }, { path: "/w/web/T-1", on: null, space: "s1" }, { path: "/w/web/T-2", on: null, space: null },
  ];
  const places = [
    { name: "Codex", space: "s1", cwd: "/elsewhere", machine: null, status: "idle" },
    { name: "Claude", space: "s9", cwd: "/w/web/T-1/src", machine: null, status: "blocked" },
    { name: "Main", space: "s0", cwd: "/src/web", machine: null, status: "working" },
    { name: "Remote", space: "s8", cwd: "/w/web/T-1", machine: "box", status: "working" },
  ];
  assert.deepEqual(agentsFor(all[1], places, all).map((a) => a.name), ["Claude", "Codex"]);
  assert.deepEqual(agentsFor(all[2], places, all), []);
  assert.deepEqual(agentsFor(all[0], places, all).map((a) => a.name), ["Main"]);
});

test("ticketDone: every worktree of the ticket ready, none held by an agent", () => {
  const r = (path, ready, isMain = false) => ({ path, isMain, judged: { ready } });
  assert.equal(ticketDone({ checkouts: [r("/a", true), r("/b", true), r("/m", false, true)] }), true);
  assert.equal(ticketDone({ checkouts: [r("/a", true), r("/b", false)] }), false);
  assert.equal(ticketDone({ checkouts: [r("/a", true), r("/b", true)] }, (c) => c.path === "/b"), false);
  assert.equal(ticketDone({ checkouts: [r("/m", false, true)] }), false);
});
