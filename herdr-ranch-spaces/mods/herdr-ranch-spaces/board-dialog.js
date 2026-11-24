// The Worktrees board: the list opens itself as a dialog with props { dialog: "board" }
// (the header's folder-tree button, or the herdr-ranch-spaces.worktrees command).
// Every checkout of every repository you work in, grouped by ticket across repositories, with
// three parts: Ready to clean up (merged or empty, nothing uncommitted: Clean up removes the
// worktree, its branch and its space after a confirm step), Leftovers (empty folders under
// ~/.herdr/worktrees and registrations whose folder is gone: Tidy), and By ticket (a chip per
// repository with its work; a click opens its space, or makes one). New ticket worktree makes
// one branch's worktree in several repositories at once. Esc closes (or goes back).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, spaces, exec, run, home } from "herdr";
import { findRepos, readRepo, groupByTicket, leftovers, cleanupPlan, cleanUp, startTicket, titleSource, keyOf } from "./board.js";
import { lookup } from "./issues.js";
import { openUrl } from "./links.js";
import { accountOf, argvAs, launchAs } from "./accounts.js";
import { ICONS } from "./actions.js";

const MOD = "herdr-ranch-spaces";
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TITLES = "spaces.board.titles";
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* no storage */ } };
const tilde = (p) => (p ?? "").replace(home(), "~");
const ago = (s) => {
  if (!s) return "";
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : `${Math.round(d / 86400)}d`;
};

export class BoardDialog extends View {
  init(_props, cx) {
    this.view = "board"; // "board" | "confirm" | "start"
    this.repos = []; this.read = new Map(); this.loading = false; this.left = null;
    this.unpicked = new Set(); // ready checkouts you untick
    this.titles = load(TITLES, {});
    this.busy = ""; this.error = ""; this.done = "";
    this.startRepos = new Set(); this.openSpaces = true; this.results = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input = InputState.new({ placeholder: "Branch, e.g. TASS-12345 or TASS-12345-short-name" });
    this.input.on("change", (_e, cx) => { this.error = ""; this.lookTitle(keyOf(this.input.value().trim()), cx); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.start(cx));
    this.reload(cx);
  }

  close() { closeOverlay(props().overlay); run(`${MOD}.focus`); }

  // Read every repository again; each one shows as soon as it's read.
  reload(cx, { fetch = false } = {}) {
    if (this.loading) return;
    this.loading = true; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.repos = await findRepos();
        if (fetch) {
          this.busy = `Fetching ${this.repos.length} repositories…`; cx.notify();
          await Promise.all(this.repos.map((r) => exec("git", ["fetch", "--prune", "--quiet"], { cwd: r.main, on: r.on, timeout: 120_000 }).catch(() => null)));
          this.busy = "";
        }
        cx.notify();
        // Three repositories at a time: each runs several git reads per checkout, and a crowd of
        // them can run past exec's 30 s.
        const queue = [...this.repos];
        await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
          for (let r = queue.shift(); r; r = queue.shift()) try { this.read.set(r.main + "\0" + (r.on ?? ""), await readRepo(r)); } catch (e) { this.read.set(r.main + "\0" + (r.on ?? ""), { ...r, checkouts: [], prunable: [], error: String(e?.message ?? e) }); }
          finally { cx.notify(); }
        }));
        this.left = await leftovers(this.checkouts().map((c) => c.path));
        this.loadTitles(cx);
      } catch (e) { this.error = String(e?.message ?? e); }
      this.loading = false; this.busy = "";
      cx.notify();
    });
  }

  checkouts() { return [...this.read.values()].flatMap((r) => r.checkouts ?? []); }
  ready() { return this.checkouts().filter((c) => c.judged.ready); }
  chosen() { return this.ready().filter((c) => !this.unpicked.has(c.path)); }

  // Ticket titles from the linked tracker, remembered between openings.
  loadTitles(cx) {
    const src = titleSource(this.repos);
    if (!src) return;
    const keys = groupByTicket(this.checkouts()).filter((g) => g.ticket && !g.key.startsWith("#") && this.titles[g.key] == null).map((g) => g.key);
    cx.spawn(async (cx) => {
      await Promise.all(keys.map(async (k) => {
        const i = await lookup(src, k).catch(() => null);
        if (i?.title) this.titles[k] = i.title;
      }));
      save(TITLES, this.titles);
      cx.notify();
    });
  }

  lookTitle(key, cx) {
    if (!key || key.startsWith("#") || this.titles[key] != null) return;
    const src = titleSource(this.repos);
    if (!src) return;
    const asked = (this.asked = key);
    cx.timer.after(350, () => cx.spawn(async (cx) => {
      if (this.asked !== asked) return;
      const i = await lookup(src, asked).catch(() => null);
      if (i?.title) { this.titles[asked] = i.title; save(TITLES, this.titles); cx.notify(); }
    }));
  }

  // A checkout's space, else a new space there (as its repository's account).
  openCheckout(c) {
    this.close();
    if (c.space && spaces().some((s) => s.id === c.space)) return run("space.select", { id: c.space });
    const a = launchAs(accountOf({ id: null }, { main: c.main, on: c.on }));
    run("space.new", { folder: c.path, machine: c.on ?? "", ...(a ? { argv: argvAs(a) } : {}) });
  }

  spaceName(id) { return id ? spaces().find((s) => s.id === id)?.name ?? "its space" : null; }

  cleanUpChosen(cx) {
    const list = this.chosen();
    if (!list.length || this.busy) return;
    this.busy = `Cleaning up ${list.length}…`; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      const failed = [];
      for (const c of list) {
        try {
          if (c.space && spaces().some((s) => s.id === c.space)) { run("space.close", { id: c.space, confirmed: true }); await cx.sleep(300); }
          await cleanUp(c);
        } catch (e) { failed.push(`${c.repo}/${c.branch}: ${e?.message ?? e}`); }
      }
      this.busy = ""; this.view = "board";
      this.done = `Cleaned up ${list.length - failed.length} of ${list.length}.`;
      this.error = failed.join("\n");
      this.read.clear();
      this.reload(cx);
    });
  }

  tidy(cx) {
    const l = this.left, prunable = [...this.read.values()].filter((r) => r.prunable?.length);
    if (this.busy || (!l?.empty.length && !prunable.length)) return;
    this.busy = "Tidying…"; cx.notify();
    cx.spawn(async (cx) => {
      await Promise.all([
        ...prunable.map((r) => exec("git", ["worktree", "prune"], { cwd: r.main, on: r.on }).catch(() => null)),
        ...(l?.empty ?? []).map((p) => exec("rmdir", [p]).catch(() => null)),
      ]);
      this.busy = ""; this.done = "Tidied.";
      this.read.clear();
      this.reload(cx);
    });
  }

  start(cx) {
    const branch = this.input.value().trim();
    const repos = this.repos.filter((r) => this.startRepos.has(r.main + "\0" + (r.on ?? "")));
    if (this.busy || !branch || !repos.length) return;
    this.busy = "Creating worktrees…"; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      const ok = await exec("git", ["check-ref-format", "--branch", branch]).catch(() => ({ code: 1 }));
      if (ok.code !== 0) { this.busy = ""; this.error = `"${branch}" isn't a valid branch name.`; return cx.notify(); }
      // Remote machines are left out: their worktrees go under their own home, which this doesn't know.
      const out = await startTicket(branch, repos.filter((r) => !r.on), home());
      this.results = out; this.busy = "";
      const made = out.filter((x) => !x.error);
      if (this.openSpaces) for (const x of made) {
        const a = launchAs(accountOf({ id: null }, { main: x.repo.main, on: null }));
        run("space.new", { folder: x.path, machine: "", focus: false, ...(a ? { argv: argvAs(a) } : {}) });
      }
      if (made.length === out.length) { this.view = "board"; this.done = `Made ${branch} in ${made.map((x) => x.repo.name).join(", ")}.`; this.read.clear(); this.reload(cx); }
      else this.error = out.filter((x) => x.error).map((x) => `${x.repo.name}: ${x.error}`).join("\n");
      cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") { if (this.view !== "board" && !this.busy) { this.view = "board"; this.error = ""; cx.notify(); } else this.close(); }
    else if (e.key === "enter" && this.view === "confirm") this.cleanUpChosen(cx);
    else return;
    cx.stop_propagation();
  }

  render() {
    const t = theme();
    const body = this.view === "confirm" ? this.confirmView(t) : this.view === "start" ? this.startView(t) : this.boardView(t);
    return v_flex().id("spaces-board").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx)).size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .child(this.header(t))
      .child(body)
      .when(Boolean(this.error), (el) => el.child(div().max_h(90).overflow_y_scrollbar().text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().items_center().gap(8).text_size(11).text_color(t.dim)
        .when(Boolean(this.busy) || this.loading, (el) => el.child(div().frames(SPIN, 90)))
        .child(div().flex_1().min_w(0).truncate().child(this.busy || (this.loading ? "Reading your repositories…" : this.done || "click a repository to open its space · esc closes"))));
  }

  button(id, text, onClick, o = {}) {
    const t = theme(), on = o.enabled !== false;
    return h_flex().id(id).flex_none().gap(6).items_center().px(10).py(4).rounded(6).text_size(12)
      .when(Boolean(o.primary), (e) => e.bg(on ? (o.danger ? t.blocked : t.accent) : t.raised).text_color(on ? t.background : t.dim).font_semibold())
      .when(!o.primary, (e) => e.border_1().border_color(t.border).bg(t.background).text_color(on ? t.foreground : t.dim))
      .when(on, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .when(Boolean(o.icon), (e) => e.child(svg(o.icon).size(13).text_color(o.primary ? t.background : t.muted)))
      .child(text);
  }

  header(t) {
    const all = this.checkouts(), groups = groupByTicket(all), ready = this.ready().length;
    const title = this.view === "start" ? "New ticket worktree" : this.view === "confirm" ? "Clean up" : "Worktrees";
    return h_flex().gap(8).items_center()
      .child(div().font_semibold().text_size(15).text_color(t.foreground).child(title))
      .when(this.view === "board", (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim)
        .child(`${groups.length} ticket${groups.length === 1 ? "" : "s"} · ${all.filter((c) => !c.isMain).length} worktrees in ${this.repos.length} repositories${ready ? ` · ${ready} ready to clean up` : ""}`)))
      .when(this.view !== "board", (el) => el.child(div().flex_1()))
      .when(this.view === "board", (el) => el
        .child(this.button("board-new", "New ticket worktree…", (cx) => { this.view = "start"; this.results = null; this.error = ""; cx.notify(); cx.timer.after(50, () => { try { this.input.focus(); } catch { /* gone */ } }); }, { icon: `${ICONS}/branch-plus.svg` }))
        .child(this.button("board-fetch", "Fetch all", (cx) => { this.read.clear(); this.reload(cx, { fetch: true }); }, { enabled: !this.loading && !this.busy, icon: CHROME("git-compare") }))
        .child(this.button("board-refresh", "Refresh", (cx) => { this.read.clear(); this.reload(cx); }, { enabled: !this.loading && !this.busy })));
  }

  section(t, title, extra) {
    return h_flex().pt(6).pb(2).gap(8).items_center().text_size(11).font_semibold().text_color(t.muted)
      .child(div().flex_1().child(title)).when(Boolean(extra), (e) => e.child(extra));
  }

  check(t, on) {
    return div().size(14).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent : t.background)
      .flex().items_center().justify_center().text_size(10).text_color(t.background).child(on ? "✓" : "");
  }

  // A checkout's work in short: ●uncommitted ↑unpushed ↓behind, or ✓.
  work(t, c) {
    const out = [];
    if (c.changes > 0) out.push(div().text_color(t.ansi3).child(`●${c.changes}`));
    const up = Math.max(c.ahead ?? 0, c.unpushed ?? 0);
    if (up > 0) out.push(div().text_color(t.ansi2).child(`↑${up}`));
    if (c.behind > 0) out.push(div().text_color(t.ansi1).child(`↓${c.behind}`));
    if (!out.length) out.push(div().text_color(c.changes == null ? t.dim : t.ansi2).child(c.changes == null ? "…" : "✓"));
    return h_flex().gap(4).flex_none().text_size(11.5).children(out);
  }

  boardView(t) {
    const all = this.checkouts(), ready = this.ready(), groups = groupByTicket(all), l = this.left;
    const prunable = [...this.read.values()].flatMap((r) => (r.prunable ?? []).map((p) => `${r.name}: ${p}`));
    const chosen = this.chosen().length;
    const list = v_flex().id("board-list").flex_1().min_h(0).overflow_y_scrollbar().gap(4).pr(4);

    if (ready.length) {
      list.child(this.section(t, `READY TO CLEAN UP · ${ready.length}`, this.button("board-clean", `Clean up ${chosen}…`, (cx) => { this.view = "confirm"; cx.notify(); }, { primary: true, enabled: chosen > 0 && !this.busy })));
      for (const c of ready) {
        const on = !this.unpicked.has(c.path);
        list.child(h_flex().id(`ready-${c.path}`).flex_none().min_h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { if (on) this.unpicked.add(c.path); else this.unpicked.delete(c.path); cx.notify(); })
          .child(this.check(t, on))
          .child(div().flex_none().text_color(t.muted).child(c.repo))
          .child(div().flex_none().text_color(t.foreground).child(c.branch))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(c.judged.reason))
          .when(Boolean(c.space), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("space open"))));
      }
    }

    if (l?.empty.length || prunable.length || l?.strays.length) {
      list.child(this.section(t, "LEFTOVERS", (l?.empty.length || prunable.length) ? this.button("board-tidy", "Tidy", (cx) => this.tidy(cx), { enabled: !this.busy }) : null));
      for (const p of l?.empty ?? []) list.child(div().px(8).text_size(12).text_color(t.muted).child(`Empty folder ${tilde(p)}`));
      for (const p of prunable) list.child(div().px(8).text_size(12).text_color(t.muted).child(`A worktree whose folder is gone (${p.replace(/^.*Removing /, "")})`));
      for (const p of l?.strays ?? []) list.child(div().px(8).text_size(12).text_color(t.ansi3).child(`${tilde(p)} isn't a worktree any more: look inside, then delete it yourself`));
    }

    const failed = [...this.read.values()].filter((r) => r.error);
    if (failed.length) {
      list.child(this.section(t, "COULDN'T READ"));
      for (const r of failed) list.child(div().px(8).text_size(12).text_color(t.blocked).child(`${r.name}: ${r.error}`));
    }

    list.child(this.section(t, "BY TICKET"));
    if (!groups.length && !this.loading) list.child(div().px(8).text_color(t.dim).child("No worktrees: every repository is on its default branch."));
    for (const g of groups) list.child(this.ticketCard(t, g));
    return list;
  }

  ticketCard(t, g) {
    const title = g.ticket ? this.titles[g.key] : null;
    const pr = g.checkouts.find((c) => c.pr)?.pr;
    const prColor = pr ? ({ OPEN: t.ansi2, MERGED: t.ansi5, CLOSED: t.ansi1 }[pr.state] ?? t.dim) : null;
    const flags = g.checkouts.flatMap((c) => c.judged.flags.map((f) => `${c.repo}: ${f}`));
    return v_flex().flex_none().gap(6).p(10).rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().font_semibold().text_color(g.ticket ? t.accent : t.foreground).child(g.key))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(title ?? ""))
        .when(Boolean(pr), (el) => el.child(div().id(`pr-${g.key}`).flex_none().px(6).rounded(4).border_1().border_color(prColor).text_size(11).text_color(prColor).cursor_pointer()
          .tooltip(pr.title).on_click(() => openUrl(pr.url)).child(`PR #${pr.number} ${pr.state.toLowerCase()}`)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(g.at))))
      .child(h_flex().flex_wrap().gap(6).children(g.checkouts.map((c) => this.chip(t, c))))
      .when(flags.length > 0, (el) => el.children(flags.map((f) => div().text_size(12).text_color(t.ansi3).child(`⚠ ${f}`))));
  }

  chip(t, c) {
    const tone = c.judged.ready ? t.ansi2 : c.judged.tone === "warn" ? t.ansi3 : t.border;
    const tip = [tilde(c.path), c.branch ? `branch ${c.branch}` : "detached", c.upstream ? `→ ${c.upstream}${c.gone ? " (gone)" : ""}` : "no upstream", c.judged.reason, c.space ? "click: show its space" : "click: open a space here"].filter(Boolean).join("\n");
    return h_flex().id(`chip-${c.path}`).flex_none().gap(6).items_center().h(24).px(8).rounded(6).border_1().border_color(tone).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(tip).on_click(() => this.openCheckout(c))
      .child(svg(c.space ? CHROME("git-compare") : `${ICONS}/unplug.svg`).size(12).text_color(c.space ? t.accent : t.dim))
      .child(div().text_size(12).text_color(t.foreground).child(c.isMain ? `${c.repo} (main checkout)` : c.repo))
      .child(this.work(t, c));
  }

  confirmView(t) {
    const list = this.chosen();
    return v_flex().flex_1().min_h(0).gap(8)
      .child(div().text_color(t.muted).child(`Clean up ${list.length} worktree${list.length === 1 ? "" : "s"}? None has uncommitted files, and each one's commits are merged, in a merged pull request, or none of its own.`))
      .child(v_flex().id("board-confirm").flex_1().min_h(0).overflow_y_scrollbar().gap(6)
        .children(list.map((c) => v_flex().flex_none().gap(2).px(8)
          .child(h_flex().gap(8).child(div().text_color(t.muted).child(c.repo)).child(div().text_color(t.foreground).child(c.branch)).child(div().text_size(12).text_color(t.dim).child(c.judged.reason)))
          .child(div().text_size(12).text_color(t.dim).child(cleanupPlan(c, this.spaceName(c.space)).join(" · "))))))
      .child(h_flex().justify_end().gap(8)
        .child(this.button("board-confirm-cancel", "Back  esc", (cx) => { this.view = "board"; cx.notify(); }, { enabled: !this.busy }))
        .child(this.button("board-confirm-go", this.busy ? "Cleaning up…" : `Clean up ${list.length}  ↵`, (cx) => this.cleanUpChosen(cx), { primary: true, danger: true, enabled: !this.busy && list.length > 0 })));
  }

  startView(t) {
    const branch = this.input.value().trim(), key = keyOf(branch), local = this.repos.filter((r) => !r.on);
    const id = (r) => r.main + "\0" + (r.on ?? "");
    const have = (r) => branch && (this.read.get(id(r))?.checkouts ?? []).some((c) => c.branch === branch);
    const n = local.filter((r) => this.startRepos.has(id(r))).length;
    return v_flex().flex_1().min_h(0).gap(8)
      .child(div().h(32).px(10).flex().items_center().rounded(6).border_1().border_color(t.accent).bg(t.background).text_color(t.foreground).child(Input.new(this.input)))
      .child(div().text_size(12).text_color(t.dim).child(key ? `${key}${this.titles[key] ? ` · ${this.titles[key]}` : ""}` : "The branch name: one worktree of it in each repository you tick, from that repository's default branch (or its existing branch)."))
      .child(this.section(t, "REPOSITORIES"))
      .child(v_flex().id("board-start-repos").flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .children(local.map((r) => {
          const on = this.startRepos.has(id(r)), there = have(r);
          return h_flex().id(`start-${r.main}`).flex_none().h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { if (on) this.startRepos.delete(id(r)); else this.startRepos.add(id(r)); cx.notify(); })
            .child(this.check(t, on))
            .child(div().flex_none().text_color(t.foreground).child(r.name))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(tilde(r.main)))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi3).child("already has it")));
        })))
      .child(h_flex().id("board-start-open").gap(8).items_center().cursor_pointer().on_click((_e, cx) => { this.openSpaces = !this.openSpaces; cx.notify(); })
        .child(this.check(t, this.openSpaces)).child(div().text_size(12).text_color(t.muted).child("Open a space in each (they nest under their repository's space)")))
      .child(h_flex().justify_end().gap(8)
        .child(this.button("board-start-cancel", "Back  esc", (cx) => { this.view = "board"; this.error = ""; cx.notify(); }, { enabled: !this.busy }))
        .child(this.button("board-start-go", this.busy ? "Creating…" : `Create in ${n}  ↵`, (cx) => this.start(cx), { primary: true, enabled: !this.busy && Boolean(branch) && n > 0 })));
  }
}
