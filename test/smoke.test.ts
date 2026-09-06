import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../src/index.ts";

type Command = { handler: (args: string, ctx: any) => Promise<void> };

function createPi() {
  const commands = new Map<string, Command>();
  const events = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const pi = {
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
      events.set(name, handler);
    },
    appendEntry() {},
    setThinkingLevel() {},
    async setModel() { return true; },
  };
  extension(pi as any);
  return { commands, events };
}

type UiCalls = {
  notifications: string[];
  widgets: Array<{ key: string; content: string[] | undefined }>;
};

function context(cwd: string, confirm = false, calls?: UiCalls) {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify(message: string) { calls?.notifications.push(message); },
      setStatus() {},
      setWidget(key: string, content: string[] | undefined) { calls?.widgets.push({ key, content }); },
      async confirm() { return confirm; },
      async select(title: string) { return title.includes("effort") ? "low" : "main"; },
      async input() { return ""; },
    },
    sessionManager: { getEntries: () => [] },
  };
}

function uiCalls(): UiCalls {
  return { notifications: [], widgets: [] };
}

test("registers the SDD command surface", () => {
  const { commands } = createPi();
  for (const command of ["sdd:on", "sdd:off", "sdd:config", "sdd:init", "sdd:agents", "sdd:resume", "sdd:status", "sdd:approve", "sdd:next", "sdd:verify"]) {
    assert.ok(commands.has(command), `missing /${command}`);
  }
});

test("shows the SDD guide once on the first screen and clears it on input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sdd-"));
  try {
    const { events } = createPi();
    const calls = uiCalls();
    const ctx = context(cwd, false, calls);
    const sessionStart = events.get("session_start")!;

    await sessionStart({ reason: "startup" }, ctx);
    await sessionStart({ reason: "startup" }, ctx);
    await sessionStart({ reason: "reload" }, ctx);

    const shown = calls.widgets.filter((call) => call.content !== undefined);
    assert.equal(shown.length, 1);
    const guide = shown[0].content!.join("\n");
    assert.match(guide, /requirements → specification → planning → implementation → verification/);
    for (const command of ["/sdd:init <feature>", "/sdd:on", "/sdd:status", "/sdd:off", "/sdd:config"]) {
      assert.ok(guide.includes(command), `guide is missing ${command}`);
    }
    assert.match(guide, /does not enable SDD automatically/);
    assert.match(guide, /normal pi workflow is unchanged/);

    await events.get("input")!({ text: "hello", source: "interactive" }, ctx);
    assert.deepEqual(calls.widgets.at(-1), { key: "sdd-guide", content: undefined });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("honors showSddGuide and safely defaults invalid configuration to visible", async () => {
  const cases: Array<{ name: string; config: string; visible: boolean }> = [
    { name: "missing field", config: "{}", visible: true },
    { name: "true", config: '{"showSddGuide":true}', visible: true },
    { name: "false", config: '{"showSddGuide":false}', visible: false },
    { name: "non-boolean", config: '{"showSddGuide":"false"}', visible: true },
    { name: "malformed file", config: "{", visible: true },
  ];

  for (const item of cases) {
    const cwd = await mkdtemp(join(tmpdir(), "pi-sdd-"));
    try {
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(join(cwd, ".pi/sdd.json"), item.config, "utf8");
      const { events } = createPi();
      const calls = uiCalls();
      await events.get("session_start")!({ reason: "startup" }, context(cwd, false, calls));
      assert.equal(calls.widgets.some((call) => call.content !== undefined), item.visible, item.name);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("preserves showSddGuide and unrelated fields when updating SDD configuration", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sdd-"));
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi/sdd.json"), JSON.stringify({
      showSddGuide: false,
      customOption: { keep: true },
      default: { executor: "main", model: "provider/old" },
      phases: { implementation: { executor: "main", model: "provider/implementation" } },
    }), "utf8");

    const { commands, events } = createPi();
    const ctx = context(cwd);
    await events.get("session_start")!({ reason: "startup" }, ctx);
    await commands.get("sdd:config")!.handler("", ctx);

    const saved = JSON.parse(await readFile(join(cwd, ".pi/sdd.json"), "utf8"));
    assert.equal(saved.showSddGuide, false);
    assert.deepEqual(saved.customOption, { keep: true });
    assert.deepEqual(saved.phases.implementation, { executor: "main", model: "provider/implementation" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("initializes artifacts and default agents", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sdd-"));
  try {
    const { commands } = createPi();
    await commands.get("sdd:init")!.handler("demo", context(cwd));
    assert.match(await readFile(join(cwd, ".sdd/specs/demo/spec.md"), "utf8"), /# demo/);
    assert.match(await readFile(join(cwd, ".pi/subagents/sdd-planner.md"), "utf8"), /name: sdd-planner/);
    assert.match(await readFile(join(cwd, ".pi/subagents.json"), "utf8"), /session_resources/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resumes a selected incomplete feature", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sdd-"));
  try {
    await mkdir(join(cwd, ".sdd/specs/unfinished"), { recursive: true });
    await writeFile(join(cwd, ".sdd/specs/unfinished/spec.md"), "# unfinished\\n\\n## Problem\\nreal problem", "utf8");
    await writeFile(join(cwd, ".sdd/specs/unfinished/tasks.md"), "- [ ] Implement the change\\n", "utf8");
    const { commands, events } = createPi();
    const ctx = context(cwd);
    ctx.ui.select = async (title: string) => title === "Resume SDD feature" ? "unfinished" : title.includes("effort") ? "low" : "main";
    await events.get("session_start")!({ reason: "startup" }, ctx);
    await commands.get("sdd:resume")!.handler("", ctx);
    const statusCalls: string[] = [];
    ctx.ui.notify = (message: string) => statusCalls.push(message);
    await commands.get("sdd:status")!.handler("", ctx);
    assert.match(statusCalls.at(-1)!, /feature: unfinished/);
    assert.match(statusCalls.at(-1)!, /phase: specification/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("asks before bypassing the commit verification gate", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sdd-"));
  try {
    const { commands, events } = createPi();
    await commands.get("sdd:init")!.handler("demo", context(cwd));
    const result = await events.get("tool_call")!({ toolName: "bash", input: { command: "git commit -m test" } }, context(cwd, false));
    assert.equal(result?.block, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
