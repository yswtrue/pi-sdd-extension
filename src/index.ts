import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type Phase = "requirements" | "specification" | "planning" | "implementation" | "verification" | "done";

type SddState = {
  enabled: boolean;
  feature?: string;
  phase: Phase;
  approvedPhase?: "specification" | "planning";
};

type Executor = "main" | "subagent";
type PhaseConfig = { model?: string; executor?: Executor; agent?: string; effort?: string };
type SddConfig = { default?: PhaseConfig; phases?: Partial<Record<Phase, PhaseConfig>> };

const defaultConfig: SddConfig = { default: { executor: "main" }, phases: {} };

const phases: Phase[] = ["requirements", "specification", "planning", "implementation", "verification", "done"];
const initialState = (): SddState => ({ enabled: false, phase: "requirements" });

function isSddState(value: unknown): value is SddState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SddState>;
  return typeof candidate.enabled === "boolean" &&
    phases.includes(candidate.phase as Phase);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createArtifacts(cwd: string, feature: string): Promise<string> {
  const root = join(cwd, ".sdd", "specs", feature);
  await mkdir(root, { recursive: true });

  const templates: Record<string, string> = {
    "spec.md": `# ${feature}\n\n## Problem\n\n## Goals\n\n## Non-goals\n\n## Acceptance criteria\n\n- [ ] \n`,
    "plan.md": `# Implementation plan: ${feature}\n\n## Design\n\n## Changes\n\n## Risks\n\n## Test plan\n`,
    "tasks.md": `# Tasks: ${feature}\n\n- [ ] Review and approve the specification\n- [ ] Review and approve the implementation plan\n- [ ] Implement the change\n- [ ] Run verification\n`,
    "verification.md": `# Verification: ${feature}\n\n## Commands\n\n## Results\n\n## Acceptance criteria\n`,
  };

  for (const [name, content] of Object.entries(templates)) {
    const path = join(root, name);
    if (!(await exists(path))) await writeFile(path, content, "utf8");
  }

  return root;
}

function sourcePath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  for (const key of ["path", "file", "filename", "filePath"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return undefined;
}

async function loadConfig(cwd: string): Promise<SddConfig> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, ".pi", "sdd.json"), "utf8")) as SddConfig;
    return { ...defaultConfig, ...raw, default: { ...defaultConfig.default, ...raw.default }, phases: raw.phases ?? {} };
  } catch {
    return defaultConfig;
  }
}

function phaseConfig(config: SddConfig, phase: Phase): PhaseConfig {
  return { ...config.default, ...config.phases?.[phase] };
}

function parseModel(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  return slash > 0 ? { provider: value.slice(0, slash), id: value.slice(slash + 1) } : undefined;
}

const defaultAgents: Record<string, { description: string; tools: string[]; instructions: string }> = {
  "sdd-requirements": {
    description: "Clarifies requirements and acceptance criteria for an SDD feature.",
    tools: ["read", "write"],
    instructions: "Clarify the problem, goals, non-goals, constraints, and acceptance criteria. Update the feature spec.md only. Do not modify source code.",
  },
  "sdd-specification": {
    description: "Creates a precise technical specification for an SDD feature.",
    tools: ["read", "write", "edit"],
    instructions: "Turn the approved requirements into a precise specification. Update spec.md and keep the work limited to SDD artifacts.",
  },
  "sdd-planner": {
    description: "Produces an implementation plan and task breakdown for an SDD feature.",
    tools: ["read", "write", "edit"],
    instructions: "Create a concrete implementation plan, affected files, risks, and test plan. Update plan.md and tasks.md only.",
  },
  "sdd-implementation": {
    description: "Implements an approved SDD plan without expanding scope.",
    tools: ["read", "bash", "write", "edit"],
    instructions: "Implement only the approved plan. Keep changes scoped to the plan, run focused tests, and report changed files and remaining risks.",
  },
  "sdd-verifier": {
    description: "Verifies an SDD implementation against its acceptance criteria.",
    tools: ["read", "bash", "write", "edit"],
    instructions: "Run the relevant tests and checks, compare results with acceptance criteria, and update verification.md with commands and results. Do not hide failures.",
  },
};

function agentDefinition(name: string, definition: (typeof defaultAgents)[string]): string {
  return `---\nname: ${name}\ndescription: ${definition.description}\ntools:\n${definition.tools.map((tool) => `  - ${tool}`).join("\n")}\n---\n\n# ${name}\n\n${definition.instructions}\n`;
}

async function initializeDefaultAgents(cwd: string, config: SddConfig): Promise<void> {
  const agentsDir = join(cwd, ".pi", "subagents");
  await mkdir(agentsDir, { recursive: true });
  for (const [name, definition] of Object.entries(defaultAgents)) {
    const path = join(agentsDir, `${name}.md`);
    if (!(await exists(path))) await writeFile(path, agentDefinition(name, definition), "utf8");
  }

  const configPath = join(cwd, ".pi", "subagents.json");
  let subagentsConfig: Record<string, unknown> = {};
  try {
    subagentsConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    // Create the project-local subagent config when it does not exist.
  }
  const profiles = (subagentsConfig.model_profiles as Record<string, unknown> | undefined) ?? {};
  for (const phase of ["requirements", "specification", "planning", "implementation", "verification"] as Phase[]) {
    const routing = phaseConfig(config, phase);
    const agent = routing.agent ?? `sdd-${phase === "specification" ? "specification" : phase === "planning" ? "planner" : phase}`;
    if (routing.model && !profiles[agent]) profiles[agent] = { model: routing.model, ...(routing.effort ? { effort: routing.effort } : {}) };
  }
  await writeFile(configPath, `${JSON.stringify({ ...subagentsConfig, model_profiles: profiles, session_resources: subagentsConfig.session_resources ?? "lean", default_mode: subagentsConfig.default_mode ?? "task" }, null, 2)}\n`, "utf8");
}

function commandText(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  return typeof value.command === "string" ? value.command : "";
}

function isGitCommitCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)git(?:\s+-C\s+[^\s]+)?\s+(?:commit|merge|revert)\b/.test(command);
}

async function configureConfig(cwd: string, ctx: ExtensionContext, current: SddConfig): Promise<SddConfig | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify("SDD configuration requires interactive UI", "warning");
    return current;
  }

  const existing = current.default ?? {};
  const executor = await ctx.ui.select("Default SDD executor", ["main", "subagent"]);
  if (!executor) return undefined;
  const model = await ctx.ui.input("Default model (provider/model-id, optional)", existing.model ?? "");
  if (model === undefined) return undefined;
  const effort = await ctx.ui.select("Default thinking effort", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (!effort) return undefined;

  let agent = existing.agent;
  if (executor === "subagent") {
    agent = await ctx.ui.input("Default sub-agent name", existing.agent ?? "sdd-phase");
    if (agent === undefined) return undefined;
  }

  const nextDefault: PhaseConfig = { executor: executor as Executor, effort };
  if (model.trim()) nextDefault.model = model.trim();
  if (executor === "subagent" && agent?.trim()) nextDefault.agent = agent.trim();
  const next: SddConfig = { ...current, default: nextDefault, phases: current.phases ?? {} };
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "sdd.json"), `${JSON.stringify(next, null, 2)}\\n`, "utf8");
  ctx.ui.notify("SDD defaults saved to .pi/sdd.json", "info");
  return next;
}

export default function (pi: ExtensionAPI) {
  let state = initialState();
  let config: SddConfig = defaultConfig;

  const saveState = () => pi.appendEntry("sdd-state", { ...state });
  const notify = (ctx: ExtensionContext, text: string) => ctx.ui.notify(text, "info");
  const featureRoot = (ctx: ExtensionContext) =>
    state.feature ? join(ctx.cwd, ".sdd", "specs", state.feature) : undefined;

  pi.on("session_start", async (_event, ctx) => {
    config = await loadConfig(ctx.cwd);
    const entries = ctx.sessionManager.getEntries();
    const saved = [...entries].reverse().find(
      (entry) => entry.type === "custom" && "data" in entry && entry.customType === "sdd-state" && isSddState(entry.data),
    );
    state = saved && "data" in saved && isSddState(saved.data) ? saved.data : initialState();
    if (state.enabled) notify(ctx, `SDD enabled: ${state.feature ?? "no feature"} (${state.phase})`);
  });

  pi.registerCommand("sdd:on", {
    description: "Enable SDD mode for the current session",
    handler: async (_args, ctx) => {
      state.enabled = true;
      saveState();
      notify(ctx, `SDD enabled (${state.phase})`);
    },
  });

  pi.registerCommand("sdd:off", {
    description: "Disable SDD mode for the current session",
    handler: async (_args, ctx) => {
      state.enabled = false;
      saveState();
      notify(ctx, "SDD disabled; normal workflow restored");
    },
  });

  pi.registerCommand("sdd:config", {
    description: "Configure default SDD executor, model, effort, and sub-agent",
    handler: async (_args, ctx) => {
      const next = await configureConfig(ctx.cwd, ctx, config);
      if (next) config = next;
    },
  });

  pi.registerCommand("sdd:agents", {
    description: "Create missing default SDD sub-agent definitions",
    handler: async (_args, ctx) => {
      await initializeDefaultAgents(ctx.cwd, config);
      notify(ctx, "Default SDD agents initialized under .pi/subagents");
    },
  });

  pi.registerCommand("sdd:init", {
    description: "Initialize an SDD feature: /sdd:init <feature>",
    handler: async (args, ctx) => {
      const feature = args.trim().split(/\s+/)[0];
      if (!feature || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(feature)) {
        ctx.ui.notify("Usage: /sdd:init <feature-name>", "warning");
        return;
      }
      if (!(await exists(join(ctx.cwd, ".pi", "sdd.json")))) {
        const configured = await configureConfig(ctx.cwd, ctx, config);
        if (!configured) {
          ctx.ui.notify("SDD initialization cancelled", "warning");
          return;
        }
        config = configured;
      }
      await initializeDefaultAgents(ctx.cwd, config);
      await createArtifacts(ctx.cwd, feature);
      state = { enabled: true, feature, phase: "requirements" };
      saveState();
      notify(ctx, `Initialized .sdd/specs/${feature}; SDD enabled`);
    },
  });

  pi.registerCommand("sdd:status", {
    description: "Show the current SDD state",
    handler: async (_args, ctx) => {
      const routing = phaseConfig(config, state.phase);
      notify(ctx, `SDD ${state.enabled ? "on" : "off"} | feature: ${state.feature ?? "none"} | phase: ${state.phase} | executor: ${routing.executor ?? "main"}${routing.model ? ` | model: ${routing.model}` : ""}`);
    },
  });

  pi.registerCommand("sdd:approve", {
    description: "Approve the current specification or plan",
    handler: async (_args, ctx) => {
      if (state.phase !== "specification" && state.phase !== "planning") {
        ctx.ui.notify("Approval is only available in specification or planning phase", "warning");
        return;
      }
      state.approvedPhase = state.phase;
      saveState();
      notify(ctx, `Approved ${state.phase}`);
    },
  });

  pi.registerCommand("sdd:next", {
    description: "Advance the SDD phase after validation",
    handler: async (_args, ctx) => {
      if (!state.enabled || !state.feature) {
        ctx.ui.notify("Run /sdd:init <feature> or /sdd:on first", "warning");
        return;
      }
      const root = featureRoot(ctx)!;
      const spec = await exists(join(root, "spec.md"));
      const plan = await exists(join(root, "plan.md"));
      const next: Partial<Record<Phase, Phase>> = {
        requirements: "specification",
        specification: "planning",
        planning: "implementation",
        implementation: "verification",
        verification: "done",
      };
      if (state.phase === "specification" && !spec) {
        ctx.ui.notify("spec.md does not exist", "warning");
        return;
      }
      if (state.phase === "planning" && (!plan || state.approvedPhase !== "planning")) {
        ctx.ui.notify("Create plan.md and approve it with /sdd:approve", "warning");
        return;
      }
      const phase = next[state.phase];
      if (!phase) {
        notify(ctx, "SDD is already complete");
        return;
      }
      state.phase = phase;
      saveState();
      notify(ctx, `SDD phase: ${phase}`);
    },
  });

  pi.registerCommand("sdd:verify", {
    description: "Enter verification phase",
    handler: async (_args, ctx) => {
      if (!state.enabled || !state.feature) {
        ctx.ui.notify("No active SDD feature", "warning");
        return;
      }
      state.phase = "verification";
      saveState();
      notify(ctx, "Verification phase: run tests and update verification.md");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.enabled) return;
    const routing = phaseConfig(config, state.phase);
    if (routing.executor !== "subagent" && routing.model) {
      const model = parseModel(routing.model);
      const selected = model && ctx.modelRegistry.find(model.provider, model.id);
      if (selected) await pi.setModel(selected);
      else if (model) ctx.ui.notify(`Configured model not found: ${routing.model}`, "warning");
    }
    if (routing.executor !== "subagent" && routing.effort && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(routing.effort)) {
      pi.setThinkingLevel(routing.effort as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max");
    }
    const delegation = routing.executor === "subagent"
      ? "\nExecution: delegate this phase to the subagent_run tool using agent " + (routing.agent ?? "sdd-phase") + ". Use mode=task and return only a concise result plus artifact paths. Do not perform the phase directly in the main session."
      : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\n## SDD mode\nYou must follow the SDD workflow.\nCurrent feature: ${state.feature ?? "not initialized"}\nCurrent phase: ${state.phase}\nConfigured executor: ${routing.executor ?? "main"}${routing.model ? `\nConfigured model: ${routing.model}` : ""}${routing.agent ? `\nConfigured agent: ${routing.agent}` : ""}${delegation}\n\nRules:\n- Work only on the current phase.\n- Keep the specification and plan artifacts up to date.\n- Do not implement source changes before an approved plan.\n- Do not claim completion before verification.\n- Use /sdd:next or /sdd:approve when a phase transition is ready.`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!state.enabled || !state.feature) return;
    if (event.toolName === "bash" && isGitCommitCommand(commandText(event.input)) && state.phase !== "done") {
      const skipVerification = ctx.hasUI && await ctx.ui.confirm(
        "Skip SDD verification?",
        `The current SDD phase is ${state.phase}. Commit has not passed the SDD verification gate. Continue anyway?`,
      );
      if (!skipVerification) {
        return { block: true, reason: "Commit blocked: complete SDD verification or explicitly confirm skipping it." };
      }
      ctx.ui.notify("SDD verification gate skipped for this commit", "warning");
      return;
    }
    if (state.phase !== "requirements" && state.phase !== "specification" && state.phase !== "planning") return;
    if (!["edit", "write", "bash"].includes(event.toolName)) return;

    const path = sourcePath(event.input);
    const root = featureRoot(ctx);
    const absolute = path ? resolve(ctx.cwd, path) : undefined;
    const insideArtifacts = absolute && root && (absolute === root || absolute.startsWith(`${root}/`));
    if (!insideArtifacts) {
      return {
        block: true,
        reason: `SDD ${state.phase} phase only permits edits under .sdd/specs/${state.feature}/.`,
      };
    }
  });
}
