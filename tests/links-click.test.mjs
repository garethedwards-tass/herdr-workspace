// Ctrl/Cmd-click on a GitHub issue or pull request link: which links Issues and Pull requests
// take (parseGithubLink, xref.js) and what their link.js handlers do with them.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { state } from "./stubs/herdr.mjs";
import { parseGithubLink } from "../shared/xref.js";

const prs = await import("../herdr-ranch-prs/mods/herdr-ranch-prs/link.js");
const issues = await import("../herdr-ranch-issues/mods/herdr-ranch-issues/link.js");
const url = (u) => ({ kind: "url", raw: u, url: u });
const SPACE = { id: "s1", active: true, folder: "/code/app", machine: null };
const src = (over = {}) => ({ terminal: "t1", machine: null, cwd: "/code/app", pane: "p1", tab: "tab1", space: "s1", ...over });

beforeEach(() => {
  state.spaces = [SPACE, { id: "s2", active: false, folder: "/code/other" }];
  state.shared = {}; state.ran = []; state.exec = null; state.layout = null; state.panes = [];
});

test("parseGithubLink: issue and pull request pages, with what may follow the number", () => {
  assert.deepEqual(parseGithubLink("https://github.com/acme/web/issues/12"), { owner: "acme", repo: "web", github: "acme/web", kind: "issue", number: 12 });
  assert.deepEqual(parseGithubLink("https://github.com/acme/web/pull/7"), { owner: "acme", repo: "web", github: "acme/web", kind: "pr", number: 7 });
  for (const tail of ["/files", "/commits", "/commits/abc123", "/checks", "#discussion_r123", "?w=1", "/", "#issuecomment-1"]) {
    assert.equal(parseGithubLink(`https://github.com/acme/web/pull/7${tail}`)?.number, 7, tail);
  }
  assert.equal(parseGithubLink("https://github.com/acme/web/issues/12#issuecomment-5")?.kind, "issue");
  assert.equal(parseGithubLink("http://www.github.com/acme/my.repo_x/pull/3")?.github, "acme/my.repo_x");
  assert.equal(parseGithubLink("HTTPS://GitHub.com/Acme/Web/pull/3")?.github, "Acme/Web");
});

test("parseGithubLink: anything else is null", () => {
  for (const u of [
    "https://github.com/acme/web", "https://github.com/acme/web/pulls", "https://github.com/acme/web/issues",
    "https://github.com/acme/web/pull/", "https://github.com/acme/web/pull/abc", "https://github.com/acme/web/pull/0",
    "https://github.com/acme/web/pull/12.diff", "https://github.com/acme/web/pull/12abc", "https://github.com/acme/web/blob/main/a.js",
    "https://github.com/acme/web/discussions/4", "https://gist.github.com/acme/web/pull/1", "https://github.com.evil.io/acme/web/pull/1",
    "https://evil.io/github.com/acme/web/pull/1", "https://gitlab.com/acme/web/-/issues/1", "ftp://github.com/acme/web/pull/1",
    "https://github.com/acme/../pull/1", "https://github.com/-acme/web/pull/1", "", null, undefined,
  ]) assert.equal(parseGithubLink(u), null, String(u));
});

test("link.js files re-export the shared parser, and mod.json rules match what it takes", () => {
  assert.equal(String(prs.parseGithubLink), String(parseGithubLink));
  assert.equal(String(issues.parseGithubLink), String(parseGithubLink));
  const rule = (m) => JSON.parse(readFileSync(new URL(`../herdr-ranch-${m}/mods/herdr-ranch-${m}/mod.json`, import.meta.url), "utf8")).link_handlers;
  const asJs = (p) => new RegExp(p.replace(/^\(\?i\)/, ""), "i");
  const [pr] = rule("prs"), [issue] = rule("issues");
  assert.equal(pr.kind, "url"); assert.equal(issue.kind, "url");
  for (const u of ["https://github.com/acme/web/pull/7", "https://github.com/acme/web/pull/7/files", "https://github.com/acme/web/pull/7#discussion_r1"]) {
    assert.ok(asJs(pr.pattern).test(u), u); assert.ok(!asJs(issue.pattern).test(u), u); assert.equal(parseGithubLink(u).kind, "pr");
  }
  for (const u of ["https://github.com/acme/web/issues/12", "https://github.com/acme/web/issues/12?x=1"]) {
    assert.ok(asJs(issue.pattern).test(u), u); assert.ok(!asJs(pr.pattern).test(u), u); assert.equal(parseGithubLink(u).kind, "issue");
  }
  for (const u of ["https://github.com/acme/web/pulls", "https://github.com/acme/web/pull/7.diff", "https://github.com/acme/web/issues/new"]) {
    assert.ok(!asJs(pr.pattern).test(u) && !asJs(issue.pattern).test(u), u);
  }
});

test("spaceOf: the clicked terminal's space, only when it is the shown one", () => {
  assert.equal(prs.spaceOf(src()).id, "s1");
  assert.equal(prs.spaceOf(src({ space: null })).id, "s1");
  assert.equal(prs.spaceOf(src({ space: "s2" })), null);
  assert.equal(issues.spaceOf(src({ space: "gone" })), null);
});

// gh and git answers: `gh api repos/<repo>/pulls/<n>` by "<repo>#<n>" in `readable`.
function fakeExec({ remote = "acme/web", readable = [], pulls = [] } = {}) {
  const calls = [];
  state.exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git") return { code: 0, stdout: "/code/app/.git\n", stderr: "" };
    if (cmd === "gh" && args[0] === "repo") return remote ? { code: 0, stdout: `${remote}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no remote" };
    if (cmd === "gh" && args[0] === "api") {
      const m = /^repos\/(.+)\/(pulls|issues)\/(\d+)$/.exec(args[1]);
      const id = `${m[1]}#${m[3]}`;
      if (!readable.includes(id)) return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      return { code: 0, stdout: m[2] === "pulls" ? `${m[3]}\n` : `${!pulls.includes(id)}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  return calls;
}

test("Pull requests link: a pull request of the space's repository opens here", async () => {
  fakeExec({ readable: ["acme/web#7"] });
  assert.equal(await prs.handleLink({ link: url("https://github.com/acme/web/pull/7/files"), source: src() }), "handled");
  const req = state.shared["ranch-open"];
  assert.equal(req.to, "herdr-ranch-prs");
  assert.deepEqual(req.what, { number: 7, github: "acme/web" });
  assert.deepEqual(state.ran.at(-1)[0], "tab.new"); // no panel slot or tab: a new tab of the mod
});

test("Pull requests link: the space's Link space entry names the repository", async () => {
  const calls = fakeExec({ remote: null, readable: ["Acme/Linked#3"] });
  state.shared["space-links"] = { s1: { main: "/code/app", on: null, github: "acme/linked" } };
  assert.equal(await prs.handleLink({ link: url("https://github.com/Acme/Linked/pull/3"), source: src() }), "handled");
  assert.equal(state.shared["ranch-open"].what.github, "acme/linked");
  assert.ok(!calls.some((c) => c[1] === "repo"));
});

test("Pull requests link: passes what it can't show", async () => {
  fakeExec({ readable: ["acme/web#7", "acme/other#7"] });
  const pass = async (u, s = src()) => assert.equal(await prs.handleLink({ link: url(u), source: s }), "pass", u);
  await pass("https://github.com/acme/other/pull/7"); // another repository
  await pass("https://github.com/acme/web/pull/8"); // gh can't read it (signed out, no access, no such pull request)
  await pass("https://github.com/acme/web/issues/7"); // an issue is Issues' link
  await pass("https://github.com/acme/web"); // not a page
  await pass("https://github.com/acme/web/pull/7", src({ space: "s2" })); // not the shown space
  assert.equal(await prs.handleLink({ link: { kind: "file", raw: "/x", path: "/x" }, source: src() }), "pass");
  fakeExec({ remote: null, readable: ["acme/web#7"] });
  await pass("https://github.com/acme/web/pull/7"); // the space has no GitHub repository
  assert.equal(state.shared["ranch-open"], undefined);
});

test("Issues link: an issue of any repository gh can read opens here", async () => {
  fakeExec({ readable: ["acme/web#12", "other/lib#4"] });
  assert.equal(await issues.handleLink({ link: url("https://github.com/other/lib/issues/4#issuecomment-1"), source: src() }), "handled");
  const req = state.shared["ranch-open"];
  assert.equal(req.to, "herdr-ranch-issues");
  assert.deepEqual(req.what, { key: "#4", github: "other/lib", url: "https://github.com/other/lib/issues/4" });
});

test("Issues link: passes what it can't show", async () => {
  fakeExec({ readable: ["acme/web#12", "acme/web#7"], pulls: ["acme/web#7"] });
  const pass = async (u, s = src()) => assert.equal(await issues.handleLink({ link: url(u), source: s }), "pass", u);
  await pass("https://github.com/acme/web/issues/7"); // a pull request behind an /issues/ link
  await pass("https://github.com/acme/web/issues/13"); // gh can't read it
  await pass("https://github.com/acme/web/pull/12"); // a pull request link is Pull requests'
  await pass("https://github.com/acme/web/issues/12", src({ space: "s2" })); // not the shown space
  state.exec = () => { throw new Error("gh: not found"); };
  await pass("https://github.com/acme/web/issues/12"); // no gh at all
  assert.equal(state.shared["ranch-open"], undefined);
});
