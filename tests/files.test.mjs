// The Files panel's colored view: which files the helper colors, tabs, and asking it for spans.
// Run: cd tests && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { state } from "./stubs/herdr.mjs";
import { supports, expand, highlight } from "../herdr-ranch-files/mods/herdr-ranch-files/code-view.js";

test("supports and highlight: the helper's languages by extension, spans through a request file", async () => {
  const ran = [];
  state.exec = (cmd, args) => {
    ran.push([cmd, ...args]);
    if (args[0] === "--languages") return { code: 0, stdout: JSON.stringify([{ name: "cfml", extensions: ["cfm", "cfc"] }, { name: "js", extensions: ["js"] }]) };
    if (args[0] === "--requests") return { code: 0, stdout: `${JSON.stringify({ id: 0, lines: [[[0, 3, "keyword"]]] })}\n` };
    return { code: 0, stdout: "" };
  };
  assert.equal(await supports("app/Thing.CFC"), true);
  assert.equal(await supports("a/b.js"), true);
  assert.equal(await supports("~/.zshrc"), true);
  assert.equal(await supports("README"), false);
  assert.equal(await supports("x.rb"), false);
  assert.deepEqual(await highlight("a.js", "var x"), [[[0, 3, "keyword"]]]);
  const req = ran.find((r) => r.includes("--requests"));
  assert.ok(req && /data\/herdr-ranch\/highlight\/file-/.test(req[2]));
  assert.ok(ran.some((r) => r[0] === "rm"));
  assert.match(state.lastWrite, /"path":"a.js","text":"var x","tab":4/);
  state.exec = null;
});

test("expand: tabs as four spaces", () => {
  assert.equal(expand("\tif (x)\t{"), "    if (x)    {");
  assert.equal(expand("plain"), "plain");
});

test("Files link: the line a clicked path names, and which links it takes", async () => {
  const { lineOf, wanted } = await import("../herdr-ranch-files/mods/herdr-ranch-files/link.js");
  assert.equal(lineOf("src/app.js:42"), 42);
  assert.equal(lineOf("src/app.js:42:7"), 42);
  assert.equal(lineOf("src/app.js:42:7:"), 42);
  assert.equal(lineOf("app.py(42)"), 42);
  assert.equal(lineOf("app.cs(42,7)"), 42);
  assert.equal(lineOf("https://x/blob/main/a.js#L42-L50"), 42);
  assert.equal(lineOf("src/app.js"), null);
  assert.equal(lineOf("src/app.js:0"), null);
  const file = (path) => ({ kind: "file", raw: path, path });
  assert.equal(wanted(file("/x/a.js"), { machine: null }), true);
  assert.equal(wanted(file("/x/shot.png"), { machine: null }), false);
  assert.equal(wanted(file("/x/a.js"), { machine: "vps" }), false);
  assert.equal(wanted({ kind: "url", raw: "https://x", url: "https://x" }, {}), false);
});
