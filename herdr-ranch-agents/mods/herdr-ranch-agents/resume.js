// Resume after a restart: a Claude Code session that a reboot or a herdr-core restart took from its
// terminal comes back in that terminal, as the account it ran as. Herdr brings each terminal back
// in its folder with a fresh shell; this types the resume into that shell.
//
// The record: labels on the terminal (herdr-core keeps them across its restarts and drops them
// with the terminal), written by the watcher once a session has its first message:
//   ranch.resume.session  the session id          ranch.resume.config  its Claude Code folder
//   ranch.resume.cwd      the folder it runs in   ranch.resume.args    its options, as JSON
//   ranch.resume.account  HERDR_RANCH_ACCOUNT     ranch.resume.shell   the terminal's own pid
//   ranch.resume.since    that pid's start time   ranch.resume.at      when it was recorded
//   ranch.resume.resumed  when it was resumed     ranch.resume.failed  when a resume gave up
//   ranch.resume.auto     "off": never by itself (kept across sessions)
//
// Gone or lost: the terminal's own process (shell) in front with no Claude Code. The same shell
// (pid and start time) means Claude Code ended under it (/exit, ctrl+c, a crash): the record is
// forgotten. Another shell means the terminal's program was replaced (a restart): it's resumed.
//
// Anything that can talk to herdr-core can write labels, so what's read back is checked again:
// the config folder must be one this computer's accounts use, the folder must exist and be
// yours (not writable by others), the conversation's file must exist, and the options go through
// resumeArgs. A resume nobody asked for (automatic) also leaves out every option that lifts
// approvals or loads settings, prompts or folders (AUTO_DROP); Resume in the list keeps them.

import { hc, appHome, home, exec, writeTextFile, readTextFile, notify, shared, setShared, terminals } from "herdr";
import { accounts, defaultGhUser } from "./accounts.js";
import { configDirs, projectDir } from "./claude.js";
import { resumeArgs, setupFor, envVar, keysFor, optionTable, q, get, read, keys, isClaude } from "./revive.js";

const P = "ranch.resume.";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FRESH = 10 * 60_000; // a shell older than this may be in use: only a click resumes into it
const GONE = 15_000;       // Claude Code missing from its own shell this long: it ended there
const SETTLE = 60_000;     // after a resume is typed, it's never taken for an ended session

// The record in a terminal's labels, or null.
export function readRecord(labels) {
  const l = labels ?? {}, id = l[P + "session"];
  if (!id) return null;
  let args = null;
  try { const a = JSON.parse(l[P + "args"] ?? "null"); if (Array.isArray(a) && a.every((x) => typeof x === "string")) args = a; } catch { /* not JSON */ }
  const n = (k) => (l[P + k] ? Number(l[P + k]) || null : null);
  return { id, config: l[P + "config"] ?? null, cwd: l[P + "cwd"] ?? null, args, account: l[P + "account"] || null,
    shell: l[P + "shell"] ?? null, since: l[P + "since"] ?? null, at: n("at"), resumed: n("resumed"), failed: n("failed"), auto: l[P + "auto"] !== "off" };
}

// `hc label` arguments for a new record (auto and nothing else carried over).
export function recordLabels(r) {
  return [`${P}session=${r.id}`, `${P}config=${r.config}`, `${P}cwd=${r.cwd}`, `${P}args=${JSON.stringify(r.args)}`, `${P}account=${r.account ?? ""}`,
    `${P}shell=${r.shell}`, `${P}since=${r.since}`, `${P}at=${r.at}`, `${P}resumed=`, `${P}failed=`];
}
const FORGET = ["session", "config", "cwd", "args", "account", "shell", "since", "at", "resumed", "failed"].map((k) => `${P}${k}=`);

// `ps -o etime=` ([[dd-]hh:]mm:ss) in ms, or null.
export function etimeMs(s) {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(s ?? "");
  if (!m) return null;
  const [, d = 0, h = 0, mi, se] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(se)) * 1000;
}

// Options an automatic resume leaves out: they lift approvals or the sandbox, or load settings,
// prompts, plugins or folders the session wouldn't otherwise. `args` are resumeArgs' (checked).
const DROP = new Set(["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--settings", "--mcp-config", "--strict-mcp-config", "--plugin-dir",
  "--system-prompt", "--system-prompt-file", "--append-system-prompt", "--append-system-prompt-file", "--add-dir", "--agents", "--allowedTools", "--allowed-tools", "--setting-sources"]);
const SAFE_MODES = new Set(["default", "plan", "dontAsk", "manual"]);
export function autoArgs(args, arity) {
  const keep = [], dropped = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
    const take = [a], n = arity[name];
    if (inline === null && name.startsWith("-")) {
      if (n === 1 && i + 1 < args.length) take.push(args[++i]);
      if (n === "?" && i + 1 < args.length && !args[i + 1].startsWith("-")) take.push(args[++i]);
      if (n === "*") while (i + 1 < args.length && !args[i + 1].startsWith("-")) take.push(args[++i]);
    }
    const mode = name === "--permission-mode" ? inline ?? take[1] : null;
    if (DROP.has(name) || (name === "--permission-mode" && !SAFE_MODES.has(mode))) dropped.push(take.join(" "));
    else keep.push(...take);
  }
  return { args: keep, dropped };
}

// Whether the shell's prompt line is empty: after one typed "x", the screen's last line is the
// line before with that x (and maybe a space) added, and nothing else changed. A right-side
// prompt loses one space for it.
const lastLine = (s) => (s ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean).at(-1) ?? null;
const squash = (s) => s.replace(/\s+/g, " ");
export function emptyPrompt(before, after) {
  const b = lastLine(before), a = lastLine(after);
  if (b == null || a == null) return false;
  if (a === `${b}x` || a === `${b} x`) return true;
  const i = a.lastIndexOf("x");
  return i > 0 && squash(a.slice(0, i) + a.slice(i + 1)) === squash(b) && /\s{2,}\S+$/.test(b); // "➜ dir   main" → "➜ dir x  main"
}

export function resumeScript({ cwd, setup, args, id, dropped = [] }) {
  return [
    "# herdr-ranch: resume a Claude Code session lost to a restart (written by the Agents list)",
    `printf '\\033[1;34m↻ Agents\\033[0m  resuming Claude Code session %s\\n' ${q(id.slice(0, 8))}`,
    ...(dropped.length ? [`printf '\\033[33m  without %s (Resume in the Agents list keeps it)\\033[0m\\n' ${q(dropped.join(", "))}`] : []),
    `cd ${q(cwd)} || exit 1`,
    setup,
    `exec claude ${args.map(q).join(" ")}`,
    "",
  ].join("\n");
}

const label = (t, ...kv) => hc(["label", t, ...kv]).catch(() => null);
const ps = async (field, pid) => ((await exec("ps", ["-o", `${field}=`, "-p", String(pid)]).catch(() => null))?.stdout ?? "").trim();
const here = (t) => !t.address.includes("/");

// Remembers the session of each Claude Code agent the watcher knows (v.claude), once it has a
// message, unless the terminal already has it on record.
export async function remember(v, all = terminals()) {
  v.recorded ??= new Map(); // terminal -> session id tried, so a failure isn't retried every tick
  const byAddr = new Map(all.map((t) => [t.address, t]));
  for (const [t, c] of v.claude ?? []) {
    const x = byAddr.get(t);
    if (!x || !here(x) || !c.id || !ID.test(c.id) || !c.offset || !c.configDir || !c.cwd) continue;
    const rec = readRecord(x.labels);
    if (rec?.id === c.id && rec.config === c.configDir) continue;
    if (v.recorded.get(t) === c.id) continue;
    v.recorded.set(t, c.id);
    const g = await get(t);
    if (!g || g.state !== "live" || !isClaude(g)) { v.recorded.delete(t); continue; }
    let args;
    try { args = resumeArgs(g.foreground.argv.slice(1), c.id, await optionTable()).slice(0, -2); } catch { continue; } // can't be repeated: not remembered
    const env = await exec("ps", ["eww", "-o", "command=", "-p", String(g.foreground.pid)]).catch(() => null);
    const account = envVar(env?.stdout, g.foreground.argv, "HERDR_RANCH_ACCOUNT") ?? null;
    const since = await ps("lstart", g.pid);
    if (!since) { v.recorded.delete(t); continue; }
    await label(t, ...recordLabels({ id: c.id, config: c.configDir, cwd: c.cwd, args, account, shell: g.pid, since, at: Date.now() }));
  }
}

// What to do with terminal x's record now: null (nothing), "forget", "resume" or "lost" (a click
// can resume it). g: its `hc get`; since/age: its own process's start time and age.
export function decide(rec, g, since, age, now, goneAt) {
  if (!rec || !g || g.state !== "live" || !g.foreground) return null;
  if (String(g.foreground.pid) !== String(g.pid)) return null; // something runs in front of its shell
  if (String(g.pid) === String(rec.shell) && since === rec.since) {
    if (rec.resumed && now - rec.resumed < SETTLE) return null;
    return goneAt != null && now - goneAt >= GONE ? "forget" : "gone";
  }
  if (rec.failed || !rec.auto || age == null || age > FRESH) return "lost";
  return "resume";
}

// Every tick: looks at each terminal with a record and no Claude Code session in it.
export async function watchRecords(v, cx, all = terminals()) {
  v.gone ??= new Map(); v.lost ??= new Map(); v.resuming ??= new Set();
  const now = Date.now(), seen = new Set();
  for (const x of all) {
    const rec = here(x) ? readRecord(x.labels) : null;
    if (!rec || v.claude?.has(x.address) || v.resuming.has(x.address)) continue;
    seen.add(x.address);
    const g = await get(x.address);
    if (isClaude(g)) continue; // it runs: the watcher just hasn't matched its session yet
    const since = g?.pid ? await ps("lstart", g.pid) : null;
    const age = g?.pid ? etimeMs(await ps("etime", g.pid)) : null;
    const what = decide(rec, g, since, age, now, v.gone.get(x.address));
    if (what !== "gone") v.gone.delete(x.address);
    if (what === "gone" && !v.gone.has(x.address)) v.gone.set(x.address, now);
    if (what === "forget") { await label(x.address, ...FORGET); v.lost.delete(x.address); v.recorded?.delete(x.address); continue; }
    if (what === "lost") { if (!v.lost.has(x.address)) { v.lost.set(x.address, rec); cx.notify(); } continue; }
    if (v.lost.delete(x.address)) cx.notify();
    if (what === "resume") startResume(v, x.address, cx, true);
  }
  for (const k of [...v.lost.keys()]) if (!seen.has(k)) { v.lost.delete(k); cx.notify(); }
}

// One Agents list per window: each writes its id beside the terminal; after a moment only the
// one whose id is still there acts.
const KEY = "agents.resume";
async function claim(v, t, cx) {
  const was = shared(KEY) ?? {};
  if (was[t] && was[t].instance !== v.instance && Date.now() - was[t].at < 30000) return false;
  setShared(KEY, { ...was, [t]: { instance: v.instance, at: Date.now() } });
  await cx.sleep(600);
  return shared(KEY)?.[t]?.instance === v.instance;
}

// Resumes terminal t's session (auto: by itself, after a restart; else a click on Resume).
export function startResume(v, t, cx, auto = false) {
  v.resuming ??= new Set();
  if (v.resuming.has(t)) return;
  v.resuming.add(t);
  v.reviving?.add(t);
  cx.notify();
  cx.spawn(async (cx) => {
    let out;
    try { out = (await claim(v, t, cx)) ? await resumeOne(t, cx, auto) : { skip: true }; } catch (e) { out = { why: String(e?.message ?? e) }; }
    v.resuming.delete(t);
    v.reviving?.delete(t);
    if (!out.skip) {
      const where = terminals().find((x) => x.address === t)?.labels?.where ?? "the terminal";
      if (out.why) {
        if (auto) await label(t, `${P}failed=${Date.now()}`);
        v.lost?.set(t, out.rec ?? true);
        notify({ title: `Couldn't resume Claude Code in ${where}`, body: out.why, level: "warning" });
      } else {
        v.lost?.delete(t);
        notify({ title: `Resumed Claude Code in ${where}`, body: out.dropped?.length ? `Without ${out.dropped.join(", ")}: a resume nobody asked for leaves those out. Restart it by hand to use them.` : undefined, level: "success", timeout: 4000 });
      }
    }
    cx.notify();
  });
}

async function resumeOne(t, cx, auto) {
  let g = await get(t);
  const rec = readRecord(g?.labels);
  if (!rec) return { why: "Its record is gone." };
  if (!g || g.state !== "live" || String(g.foreground?.pid) !== String(g.pid)) return { why: "Something else is running in that terminal.", rec };
  if (!ID.test(rec.id)) return { why: "Its record names no valid session.", rec };
  const h = home();
  if (!rec.config || !configDirs(h, shared("ranch-accounts")).includes(rec.config)) return { why: "Its Claude Code folder isn't one of your accounts'.", rec };
  if (!rec.cwd?.startsWith("/")) return { why: "Its record names no folder.", rec };
  const ok = await exec("sh", ["-c", 'd=$1; [ -d "$d" ] && [ -O "$d" ] && [ -z "$(find "$d" -maxdepth 0 -perm -002)" ]', "sh", rec.cwd]).catch(() => null);
  if (ok?.code !== 0) return { why: `Its folder ${rec.cwd} is missing, not yours, or writable by others.`, rec };
  const file = `${projectDir(rec.config, rec.cwd)}/${rec.id}.jsonl`;
  if ((await exec("test", ["-f", file]).catch(() => null))?.code !== 0) { await label(t, ...FORGET); return { why: "Its conversation file is gone, so there's nothing to resume.", rec }; }
  const table = await optionTable();
  let args;
  try { args = resumeArgs(rec.args ?? [], rec.id, table).slice(0, -2); } catch (e) { return { why: `${e.message}: resume it by hand (claude --resume ${rec.id}).`, rec }; }
  let dropped = [];
  if (auto) ({ args, dropped } = autoArgs(args, table));
  const setup = setupFor({ configDir: rec.config, home: h, named: rec.account, list: accounts(), defaultGh: defaultGhUser() });
  const dir = `${appHome()}/data/herdr-ranch-agents`, path = `${dir}/resume-${t}.sh`;
  const line = keysFor(`sh ${path}`);
  if (!line) return { why: "The script's path can't be typed into the terminal.", rec };
  await exec("mkdir", ["-p", dir]);
  await writeTextFile(path, resumeScript({ cwd: rec.cwd, setup, args: [...args, "--resume", rec.id], id: rec.id, dropped }), await readTextFile(path).catch(() => null));

  // The shell's prompt: still, and empty (an "x" typed shows alone after it, then is removed).
  const s0 = await read(t);
  await cx.sleep(1500);
  if ((await read(t)) !== s0) return { why: "The terminal is busy (its screen keeps changing).", rec };
  await keys(t, ["x"]);
  let s1 = s0;
  for (let i = 0; i < 10 && s1 === s0; i++) { await cx.sleep(150); s1 = await read(t); }
  await keys(t, ["backspace"]);
  if (!emptyPrompt(s0, s1)) return { why: "Its shell's prompt isn't empty: clear it, then click Resume.", rec };
  // Marked before typing, so no other look takes it for a new shell again.
  const since = await ps("lstart", g.pid);
  await label(t, `${P}shell=${g.pid}`, `${P}since=${since}`, `${P}resumed=${Date.now()}`, `${P}failed=`);
  await keys(t, [...line, "enter"]);
  for (let i = 0; i < 40; i++) {
    await cx.sleep(500);
    g = await get(t);
    if (isClaude(g)) return { dropped };
  }
  return { why: "Claude Code didn't start: check the terminal.", rec };
}

// The agent menu's switch: whether this terminal's sessions come back by themselves.
export const autoOn = (labels) => labels?.[P + "auto"] !== "off";
export const setAuto = (t, on) => label(t, `${P}auto=${on ? "" : "off"}`);
