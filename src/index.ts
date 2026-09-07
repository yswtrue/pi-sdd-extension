import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdir, access, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

type Phase =
  | "requirements"
  | "specification"
  | "planning"
  | "implementation"
  | "verification"
  | "done";

type SddState = {
  enabled: boolean;
  feature?: string;
  phase: Phase;
  approvedPhase?: "requirements" | "specification" | "planning";
};

type Executor = "main" | "subagent";
type PhaseConfig = {
  model?: string;
  executor?: Executor;
  agent?: string;
  effort?: string;
};
type ModelPreset = "anthropic" | "openai";
type SddConfig = {
  default?: PhaseConfig;
  phases?: Partial<Record<Phase, PhaseConfig>>;
  modelPreset?: ModelPreset;
  showSddGuide?: boolean;
};

const defaultConfig: SddConfig = {
  default: { executor: "main" },
  phases: {},
  showSddGuide: true,
};
const sddGuideWidgetKey = "sdd-guide";
const sddGuide = [
  "SDD guide — loading this extension does not enable SDD automatically.",
  "Workflow: requirements → specification → planning → implementation → verification.",
  "Start a feature: `/sdd:init <feature>` · Enable in this session: `/sdd:on`",
  "Check status: `/sdd:status` · Disable for this session: `/sdd:off`",
  "Configure the default executor/model and other options: `/sdd:config`",
  "Without `/sdd:on` or `/sdd:init`, the normal pi workflow is unchanged.",
];

type AgentModelPreset = { model: string; effort: string };
type SubagentPreset = {
  label: string;
  agents: Record<string, AgentModelPreset>;
};

const subagentModelPresets: Record<ModelPreset, SubagentPreset> = {
  anthropic: {
    label: "Anthropic (Claude 5)",
    agents: Object.fromEntries([
      ["sdd-requirements", { model: "anthropic/claude-5", effort: "low" }],
      ["sdd-specification", { model: "anthropic/claude-5", effort: "medium" }],
      ["sdd-planner", { model: "anthropic/claude-5", effort: "medium" }],
      ["sdd-implementation", { model: "anthropic/claude-5", effort: "high" }],
      ["sdd-verifier", { model: "anthropic/claude-5", effort: "high" }],
    ]),
  },
  openai: {
    label: "OpenAI (GPT-5.6 family)",
    agents: Object.fromEntries([
      [
        "sdd-requirements",
        { model: "openai-codex/gpt-5.6-luna", effort: "low" },
      ],
      [
        "sdd-specification",
        { model: "openai-codex/gpt-5.6-sol", effort: "high" },
      ],
      [
        "sdd-planner",
        { model: "openai-codex/gpt-5.6-terra", effort: "medium" },
      ],
      [
        "sdd-implementation",
        { model: "openai-codex/gpt-5.6-sol", effort: "high" },
      ],
      ["sdd-verifier", { model: "openai-codex/gpt-5.6-terra", effort: "high" }],
    ]),
  },
};

const phases: Phase[] = [
  "requirements",
  "specification",
  "planning",
  "implementation",
  "verification",
  "done",
];
const initialState = (): SddState => ({
  enabled: false,
  phase: "requirements",
});

function isSddState(value: unknown): value is SddState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SddState>;
  return (
    typeof candidate.enabled === "boolean" &&
    phases.includes(candidate.phase as Phase) &&
    (candidate.approvedPhase === undefined ||
      ["requirements", "specification", "planning"].includes(
        candidate.approvedPhase,
      ))
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listIncompleteFeatures(cwd: string): Promise<string[]> {
  const root = join(cwd, ".sdd", "specs");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const incomplete: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const tasksPath = join(root, entry.name, "tasks.md");
      try {
        const tasks = await readFile(tasksPath, "utf8");
        if (!tasks.includes("- [x]")) incomplete.push(entry.name);
      } catch {
        incomplete.push(entry.name);
      }
    }
    return incomplete.sort();
  } catch {
    return [];
  }
}

async function inferFeaturePhase(cwd: string, feature: string): Promise<Phase> {
  const root = join(cwd, ".sdd", "specs", feature);
  const read = async (name: string) => {
    try {
      return await readFile(join(root, name), "utf8");
    } catch {
      return "";
    }
  };
  const spec = await read("spec.md");
  const plan = await read("plan.md");
  const tasks = await read("tasks.md");
  const verification = await read("verification.md");
  if (!spec.trim() || spec.includes("## Problem\n\n## Goals"))
    return "requirements";
  if (!plan.trim() || plan.includes("## Design\n\n## Changes"))
    return "specification";
  if (
    verification.includes("## Results\\n") &&
    !verification.includes("## Results\\n\\n")
  )
    return "verification";
  if (!tasks.includes("- [x] Implement the change")) return "planning";
  return "implementation";
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
    const raw = JSON.parse(
      await readFile(join(cwd, ".pi", "sdd.json"), "utf8"),
    ) as SddConfig;
    return {
      ...defaultConfig,
      ...raw,
      default: { ...defaultConfig.default, ...raw.default },
      phases: raw.phases ?? {},
    };
  } catch {
    return defaultConfig;
  }
}

function phaseConfig(config: SddConfig, phase: Phase): PhaseConfig {
  return { ...config.default, ...config.phases?.[phase] };
}

function parseModel(
  value: string,
): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  return slash > 0
    ? { provider: value.slice(0, slash), id: value.slice(slash + 1) }
    : undefined;
}

const defaultAgents: Record<
  string,
  { description: string; tools: string[]; instructions: string }
> = {
  "sdd-requirements": {
    description:
      "Clarifies requirements and acceptance criteria for an SDD feature.",
    tools: ["read", "write"],
    instructions:
      "Clarify the problem, goals, non-goals, constraints, and acceptance criteria. Update only .sdd/specs/<feature>/spec.md, replacing <feature> with the current feature name. Do not create a root-level spec.md and do not modify source code.",
  },
  "sdd-specification": {
    description:
      "Creates a precise technical specification for an SDD feature.",
    tools: ["read", "write", "edit"],
    instructions:
      "Turn the approved requirements into a precise specification. Update only .sdd/specs/<feature>/spec.md, replacing <feature> with the current feature name. Keep the work limited to SDD artifacts.",
  },
  "sdd-planner": {
    description:
      "Produces an implementation plan and task breakdown for an SDD feature.",
    tools: ["read", "write", "edit"],
    instructions:
      "Create a concrete implementation plan, affected files, risks, and test plan. Update only .sdd/specs/<feature>/plan.md and .sdd/specs/<feature>/tasks.md, replacing <feature> with the current feature name.",
  },
  "sdd-implementation": {
    description: "Implements an approved SDD plan without expanding scope.",
    tools: ["read", "bash", "write", "edit"],
    instructions:
      "Implement only the approved plan. Keep changes scoped to the plan, run focused tests, and report changed files and remaining risks.",
  },
  "sdd-verifier": {
    description:
      "Verifies an SDD implementation against its acceptance criteria.",
    tools: ["read", "bash", "write", "edit"],
    instructions:
      "Run the relevant tests and checks, compare results with acceptance criteria, and update verification.md with commands and results. Do not hide failures.",
  },
};

function agentDefinition(
  name: string,
  definition: (typeof defaultAgents)[string],
): string {
  return `---\nname: ${name}\ndescription: ${definition.description}\ntools:\n${definition.tools.map((tool) => `  - ${tool}`).join("\n")}\n---\n\n# ${name}\n\n${definition.instructions}\n`;
}

async function initializeDefaultAgents(
  cwd: string,
  config: SddConfig,
): Promise<void> {
  const agentsDir = join(cwd, ".pi", "subagents");
  await mkdir(agentsDir, { recursive: true });
  for (const [name, definition] of Object.entries(defaultAgents)) {
    const path = join(agentsDir, `${name}.md`);
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch {
      /* Create missing defaults below. */
    }
    const isLegacyGeneratedDefinition =
      existing.includes(`# ${name}`) &&
      !existing.includes(".sdd/specs/<feature>") &&
      [
        "sdd-requirements",
        "sdd-specification",
        "sdd-planner",
        "sdd-verifier",
      ].includes(name);
    if (!existing || isLegacyGeneratedDefinition) {
      await writeFile(path, agentDefinition(name, definition), "utf8");
    }
  }

  const configPath = join(cwd, ".pi", "subagents.json");
  let subagentsConfig: Record<string, unknown> = {};
  try {
    subagentsConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    // Create the project-local subagent config when it does not exist.
  }
  const profiles =
    (subagentsConfig.model_profiles as Record<string, unknown> | undefined) ??
    {};
  for (const phase of [
    "requirements",
    "specification",
    "planning",
    "implementation",
    "verification",
  ] as Phase[]) {
    const routing = phaseConfig(config, phase);
    const agent =
      routing.agent ??
      `sdd-${phase === "specification" ? "specification" : phase === "planning" ? "planner" : phase}`;
    const preset = config.modelPreset
      ? subagentModelPresets[config.modelPreset].agents[agent]
      : undefined;
    if (preset) {
      profiles[agent] = { model: preset.model, effort: preset.effort };
    } else if (routing.model && !profiles[agent]) {
      profiles[agent] = {
        model: routing.model,
        ...(routing.effort ? { effort: routing.effort } : {}),
      };
    }
  }
  await writeFile(
    configPath,
    `${JSON.stringify({ ...subagentsConfig, model_profiles: profiles, session_resources: subagentsConfig.session_resources ?? "lean", default_mode: subagentsConfig.default_mode ?? "task" }, null, 2)}\n`,
    "utf8",
  );
}

function commandText(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  return typeof value.command === "string" ? value.command : "";
}

function isGitCommitCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)git(?:\s+-C\s+[^\s]+)?\s+(?:commit|merge|revert)\b/.test(
    command,
  );
}

async function configureConfig(
  cwd: string,
  ctx: ExtensionContext,
  current: SddConfig,
): Promise<SddConfig | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify("SDD configuration requires interactive UI", "warning");
    return current;
  }

  const existing = current.default ?? {};
  const executor = await ctx.ui.select("Default SDD executor", [
    "main",
    "subagent",
  ]);
  if (!executor) return undefined;
  let model: string | undefined;
  let modelPreset = current.modelPreset;
  if (executor === "subagent") {
    const selectedPreset = await ctx.ui.select(
      "Default sub-agent provider",
      Object.entries(subagentModelPresets).map(
        ([key, preset]) => `${key}: ${preset.label}`,
      ),
    );
    if (!selectedPreset) return undefined;
    modelPreset = selectedPreset.startsWith("openai:") ? "openai" : "anthropic";
    model = subagentModelPresets[modelPreset].agents["sdd-requirements"].model;
  } else {
    const inputModel = await ctx.ui.input(
      "Default model (provider/model-id, optional)",
      existing.model ?? "",
    );
    if (inputModel === undefined) return undefined;
    model = inputModel.trim() || undefined;
  }
  const effort = await ctx.ui.select("Default thinking effort", [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  if (!effort) return undefined;

  let agent = existing.agent;
  if (executor === "subagent") {
    agent = await ctx.ui.input(
      "Default sub-agent name",
      existing.agent ?? "sdd-phase",
    );
    if (agent === undefined) return undefined;
  }

  const nextDefault: PhaseConfig = { executor: executor as Executor, effort };
  if (executor === "main" && model) nextDefault.model = model;
  if (executor === "subagent" && agent?.trim())
    nextDefault.agent = agent.trim();
  const phases = { ...(current.phases ?? {}) };
  if (executor === "subagent" && modelPreset) {
    for (const phase of [
      "requirements",
      "specification",
      "planning",
      "implementation",
      "verification",
    ] as Phase[]) {
      const agent =
        phases[phase]?.agent ??
        `sdd-${phase === "specification" ? "specification" : phase === "planning" ? "planner" : phase}`;
      const preset = subagentModelPresets[modelPreset].agents[agent];
      if (preset) {
        const { model: _phaseModel, ...phaseWithoutModel } =
          phases[phase] ?? {};
        phases[phase] = { ...phaseWithoutModel, effort: preset.effort };
      }
    }
  }
  const next: SddConfig = {
    ...current,
    default: nextDefault,
    phases,
    modelPreset,
  };
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "sdd.json"),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  ctx.ui.notify("SDD defaults saved to .pi/sdd.json", "info");
  return next;
}

export default function (pi: ExtensionAPI) {
  let state = initialState();
  let config: SddConfig = defaultConfig;
  let guideShown = false;
  let guideWidgetVisible = false;

  const saveState = () => pi.appendEntry("sdd-state", { ...state });
  const notify = (ctx: ExtensionContext, text: string) =>
    ctx.ui.notify(text, "info");
  const featureRoot = (ctx: ExtensionContext) =>
    state.feature ? join(ctx.cwd, ".sdd", "specs", state.feature) : undefined;

  const updateStatus = (ctx: ExtensionContext) => {
    if (!state.enabled) {
      ctx.ui.setStatus("sdd", undefined);
      return;
    }
    const routing = phaseConfig(config, state.phase);
    const progress = `${Math.max(phases.indexOf(state.phase) + 1, 1)}/${phases.length}`;
    ctx.ui.setStatus(
      "sdd",
      `SDD ${state.feature ?? "未初始化"} · ${state.phase} · ${progress} · ${routing.executor ?? "main"}${state.approvedPhase === state.phase ? " · approved" : " · approval required"}`,
    );
  };

  pi.on("session_start", async (event, ctx) => {
    config = await loadConfig(ctx.cwd);
    const entries = ctx.sessionManager.getEntries();
    const saved = [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.type === "custom" &&
          "data" in entry &&
          entry.customType === "sdd-state" &&
          isSddState(entry.data),
      );
    state =
      saved && "data" in saved && isSddState(saved.data)
        ? saved.data
        : initialState();
    if (state.enabled)
      notify(
        ctx,
        `SDD enabled: ${state.feature ?? "no feature"} (${state.phase})`,
      );
    updateStatus(ctx);

    if (
      !guideShown &&
      event.reason !== "reload" &&
      config.showSddGuide !== false &&
      ctx.hasUI
    ) {
      guideShown = true;
      try {
        ctx.ui.setWidget(sddGuideWidgetKey, sddGuide);
        guideWidgetVisible = true;
      } catch {
        // Older compatible hosts may not provide startup widgets.
        ctx.ui.notify(sddGuide.join("\n"), "info");
      }
    }
  });

  pi.on("input", async (_event, ctx) => {
    if (!guideWidgetVisible) return;
    ctx.ui.setWidget(sddGuideWidgetKey, undefined);
    guideWidgetVisible = false;
  });

  pi.registerCommand("sdd:on", {
    description: "Enable SDD mode for the current session",
    handler: async (_args, ctx) => {
      state.enabled = true;
      saveState();
      notify(ctx, `SDD enabled (${state.phase})`);
      updateStatus(ctx);
    },
  });

  pi.registerCommand("sdd:off", {
    description: "Disable SDD mode for the current session",
    handler: async (_args, ctx) => {
      state.enabled = false;
      saveState();
      notify(ctx, "SDD disabled; normal workflow restored");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("sdd:config", {
    description: "Configure default SDD executor, model, effort, and sub-agent",
    handler: async (_args, ctx) => {
      const next = await configureConfig(ctx.cwd, ctx, config);
      if (next) config = next;
      updateStatus(ctx);
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
      updateStatus(ctx);
    },
  });

  pi.registerCommand("sdd:resume", {
    description: "Resume an incomplete SDD feature in the current directory",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("SDD resume requires interactive UI", "warning");
        return;
      }
      const features = await listIncompleteFeatures(ctx.cwd);
      if (!features.length) {
        ctx.ui.notify(
          "No incomplete SDD features found under .sdd/specs",
          "info",
        );
        return;
      }
      const selected = await ctx.ui.select("Resume SDD feature", features);
      if (!selected) return;
      state = {
        enabled: true,
        feature: selected,
        phase: await inferFeaturePhase(ctx.cwd, selected),
      };
      await initializeDefaultAgents(ctx.cwd, config);
      saveState();
      notify(
        ctx,
        `Resumed .sdd/specs/${selected}; SDD enabled at ${state.phase} phase`,
      );
      updateStatus(ctx);
    },
  });

  pi.registerCommand("sdd:status", {
    description: "Show the current SDD state",
    handler: async (_args, ctx) => {
      const routing = phaseConfig(config, state.phase);
      notify(
        ctx,
        `SDD ${state.enabled ? "on" : "off"} | feature: ${state.feature ?? "none"} | phase: ${state.phase} | approval: ${state.approvedPhase === state.phase ? "approved" : "required"} | executor: ${routing.executor ?? "main"}${routing.model ? ` | model: ${routing.model}` : ""}`,
      );
    },
  });

  pi.registerCommand("sdd:approve", {
    description: "Approve the current requirements, specification, or plan",
    handler: async (_args, ctx) => {
      if (
        state.phase !== "requirements" &&
        state.phase !== "specification" &&
        state.phase !== "planning"
      ) {
        ctx.ui.notify(
          "Approval is only available in requirements, specification, or planning phase",
          "warning",
        );
        return;
      }
      state.approvedPhase = state.phase;
      saveState();
      notify(ctx, `Approved ${state.phase}`);
      updateStatus(ctx);
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
      if (
        state.phase === "requirements" &&
        (!spec || state.approvedPhase !== "requirements")
      ) {
        ctx.ui.notify(
          "Complete spec.md and approve the requirements with /sdd:approve",
          "warning",
        );
        return;
      }
      if (
        state.phase === "specification" &&
        (!spec || !plan || state.approvedPhase !== "specification")
      ) {
        ctx.ui.notify(
          "Complete plan.md and approve the specification with /sdd:approve",
          "warning",
        );
        return;
      }
      if (state.phase === "planning" && state.approvedPhase !== "planning") {
        ctx.ui.notify(
          "Approve the implementation plan with /sdd:approve",
          "warning",
        );
        return;
      }
      const phase = next[state.phase];
      if (!phase) {
        notify(ctx, "SDD is already complete");
        return;
      }
      state.phase = phase;
      state.approvedPhase = undefined;
      saveState();
      notify(ctx, `SDD phase: ${phase}`);
      updateStatus(ctx);
      // A slash command does not itself start another agent turn. Queue the
      // next phase explicitly so /sdd:next does not require a second
      // "continue" message from the user.
      (pi as any).sendUserMessage?.(
        `Continue the SDD ${phase} phase for ${state.feature}. Work only on this phase and stop when it is ready for approval or /sdd:next.`,
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("sdd:verify", {
    description: "Enter verification phase",
    handler: async (_args, ctx) => {
      if (!state.enabled || !state.feature) {
        ctx.ui.notify("No active SDD feature", "warning");
        return;
      }
      if (state.phase !== "implementation") {
        ctx.ui.notify(
          "Verification can only start after the implementation phase",
          "warning",
        );
        return;
      }
      state.phase = "verification";
      saveState();
      notify(ctx, "Verification phase: run tests and update verification.md");
      updateStatus(ctx);
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.enabled) return;
    const routing = phaseConfig(config, state.phase);
    if (routing.executor !== "subagent" && routing.model) {
      const model = parseModel(routing.model);
      const selected =
        model && ctx.modelRegistry.find(model.provider, model.id);
      if (selected) await pi.setModel(selected);
      else if (model)
        ctx.ui.notify(
          `Configured model not found: ${routing.model}`,
          "warning",
        );
    }
    if (
      routing.executor !== "subagent" &&
      routing.effort &&
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        routing.effort,
      )
    ) {
      pi.setThinkingLevel(
        routing.effort as
          | "off"
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh"
          | "max",
      );
    }
    const delegation =
      routing.executor === "subagent"
        ? "\nExecution: delegate this phase to the subagent_run tool using agent " +
          (routing.agent ?? "sdd-phase") +
          ". The current feature artifact directory is .sdd/specs/" +
          (state.feature ?? "<feature>") +
          ". Use mode=task, write artifacts only in that directory, and return only a concise result plus artifact paths. Do not perform the phase directly in the main session."
        : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\n## SDD mode\nYou must follow the SDD workflow.\nCurrent feature: ${state.feature ?? "not initialized"}\nCurrent phase: ${state.phase}\nConfigured executor: ${routing.executor ?? "main"}${routing.model ? `\nConfigured model: ${routing.model}` : ""}${routing.agent ? `\nConfigured agent: ${routing.agent}` : ""}${delegation}\n\nRules:\n- Work only on the current phase.\n- Keep the specification and plan artifacts up to date.\n- Do not implement source changes before an approved plan.\n- Never delegate or start an implementation subagent unless the current phase is implementation.\n- Do not advance phases automatically; only /sdd:approve followed by /sdd:next may advance a phase.\n- Do not claim completion before verification.\n- Use /sdd:next or /sdd:approve when a phase transition is ready.`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!state.enabled || !state.feature) return;
    if (event.toolName === "subagent_run") {
      const input = event.input as Record<string, unknown>;
      const agent = typeof input.agent === "string" ? input.agent : "";
      const task = typeof input.task === "string" ? input.task : "";
      const requestsImplementation =
        /sdd-implementation/i.test(agent) ||
        (/\b(?:implement|implementation)\b/i.test(task) &&
          /\b(?:source|code|change|files?)\b/i.test(task));
      if (requestsImplementation && state.phase !== "implementation") {
        return {
          block: true,
          reason: `Implementation delegation blocked: approve the plan and enter the implementation phase with /sdd:next first (current phase: ${state.phase}).`,
        };
      }
    }
    if (
      event.toolName === "bash" &&
      isGitCommitCommand(commandText(event.input)) &&
      state.phase !== "done"
    ) {
      const skipVerification =
        ctx.hasUI &&
        (await ctx.ui.confirm(
          "Skip SDD verification?",
          `The current SDD phase is ${state.phase}. Commit has not passed the SDD verification gate. Continue anyway?`,
        ));
      if (!skipVerification) {
        return {
          block: true,
          reason:
            "Commit blocked: complete SDD verification or explicitly confirm skipping it.",
        };
      }
      ctx.ui.notify("SDD verification gate skipped for this commit", "warning");
      return;
    }
    if (
      state.phase !== "requirements" &&
      state.phase !== "specification" &&
      state.phase !== "planning"
    )
      return;
    if (!["edit", "write", "bash"].includes(event.toolName)) return;

    const path = sourcePath(event.input);
    const root = featureRoot(ctx);
    const absolute = path ? resolve(ctx.cwd, path) : undefined;
    const insideArtifacts =
      absolute &&
      root &&
      (absolute === root || absolute.startsWith(`${root}/`));
    if (!insideArtifacts) {
      return {
        block: true,
        reason: `SDD ${state.phase} phase only permits edits under .sdd/specs/${state.feature}/.`,
      };
    }

    // Any artifact edit invalidates the approval for the current phase.
    if (state.approvedPhase === state.phase) {
      state.approvedPhase = undefined;
      saveState();
      updateStatus(ctx);
    }
  });
}
