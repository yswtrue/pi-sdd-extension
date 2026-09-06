import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

function context(cwd: string, confirm = false) {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify() {},
      async confirm() { return confirm; },
      async select() { return "main"; },
      async input() { return ""; },
    },
    sessionManager: { getEntries: () => [] },
  };
}

test("registers the SDD command surface", () => {
  const { commands } = createPi();
  for (const command of ["sdd:on", "sdd:off", "sdd:config", "sdd:init", "sdd:agents", "sdd:status", "sdd:approve", "sdd:next", "sdd:verify"]) {
    assert.ok(commands.has(command), `missing /${command}`);
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
