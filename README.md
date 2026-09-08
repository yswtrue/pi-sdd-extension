# pi-sdd-extension

A session-scoped SDD workflow extension for pi.

## Commands

```text
/sdd:init <feature>  Create SDD artifacts and enable SDD
/sdd:on              Enable SDD for the current session
/sdd:off             Return to the normal workflow
/sdd:status          Show feature, phase, and routing
/sdd:resume          Resume an incomplete feature from the current directory
/sdd:config          Interactively configure SDD defaults
/sdd:agents          Initialize missing default sub-agent definitions
/sdd:approve         Approve the current requirements, specification, or plan
/sdd:next            Advance after validation and start the next phase
/sdd:change[:requirements|:specification|:planning] <description>  Record a change and rewind the workflow
/sdd:verify          Enter verification
```

## Phase routing

Project-local `.pi/sdd.json` controls the executor and model for each phase:

```json
{
  "showSddGuide": true,
  "default": { "executor": "main" },
  "phases": {
    "requirements": {
      "executor": "subagent",
      "agent": "sdd-requirements"
    },
    "specification": {
      "executor": "subagent",
      "agent": "sdd-specification"
    },
    "implementation": {
      "executor": "main",
      "model": "openai/gpt-5.6"
    },
    "verification": {
      "executor": "subagent",
      "agent": "sdd-verifier"
    }
  }
}
```

Advancing is approval-gated: complete the current artifact, run `/sdd:approve`, then run `/sdd:next`. Editing an approved artifact clears its approval. `/sdd:next` queues the next phase automatically; no extra `continue` message is required.

When requirements change after planning or implementation has started, use `/sdd:change <description>` or the explicit aliases `/sdd:change:requirements`, `/sdd:change:specification`, and `/sdd:change:planning`. The change is appended to `changes.md`, clears approval, and rewinds the workflow to that phase. Update the artifacts, approve again, and continue normally.

The SDD usage guide is shown on the first screen by default. Set `"showSddGuide": false` in `.pi/sdd.json` to hide only this startup guide; SDD commands and workflow behavior remain available.

`model` uses `provider/model-id`, and is applied to the main Pi session before the phase starts. `/sdd:config` interactively configures the default executor, model, effort, and sub-agent while preserving phase-specific overrides. When the default executor is `subagent`, the wizard provides two preconfigured provider choices: Anthropic (Claude 5) and OpenAI (GPT-5.6 family). The OpenAI preset routes requirements to `openai/gpt-5.6-luna`, specification and implementation to `openai/gpt-5.6-sol`, and planning and verification to `openai/gpt-5.6-terra`. If `.pi/sdd.json` does not exist, `/sdd:init <feature>` runs the same wizard before creating the feature. For `executor: "subagent"`, the extension instructs the model to call `subagent_run`; configure the actual subagent model in the matching project `.pi/subagents.json` profile:

```json
{
  "model_profiles": {
    "sdd-requirements": { "model": "anthropic/claude-5", "effort": "low" },
    "sdd-specification": { "model": "anthropic/claude-5", "effort": "medium" },
    "sdd-planner": { "model": "anthropic/claude-5", "effort": "medium" },
    "sdd-implementation": { "model": "anthropic/claude-5", "effort": "high" },
    "sdd-verifier": { "model": "anthropic/claude-5", "effort": "high" }
  },
  "model_presets": {
    "anthropic": {
      "sdd-requirements": "anthropic/claude-5",
      "sdd-specification": "anthropic/claude-5",
      "sdd-planner": "anthropic/claude-5",
      "sdd-implementation": "anthropic/claude-5",
      "sdd-verifier": "anthropic/claude-5"
    },
    "openai": {
      "sdd-requirements": "openai/gpt-5.6-luna",
      "sdd-specification": "openai/gpt-5.6-sol",
      "sdd-planner": "openai/gpt-5.6-terra",
      "sdd-implementation": "openai/gpt-5.6-sol",
      "sdd-verifier": "openai/gpt-5.6-terra"
    }
  },
  "session_resources": "lean",
  "default_mode": "task"
}
```

This keeps each phase's detailed work in a subagent session and returns only a concise result to the main context. `/sdd:init` creates default agents for requirements, specification, planning, implementation, and verification under `.pi/subagents/`, plus a project `.pi/subagents.json`. Existing definitions are preserved.
The SDD package does not bundle or load `pi-subagents-j0k3r` automatically, because Pi rejects duplicate registration when it is already installed globally. Install it once separately when using subagent phases:

```bash
pi install npm:pi-subagents-j0k3r
```
Running `/sdd:init <feature>` also creates missing defaults under `.pi/subagents/` and `.pi/subagents.json`. Existing files are preserved.

Without `/sdd:on` or `/sdd:init`, the extension leaves the normal pi workflow unchanged.
While SDD is enabled, `git commit`, `git merge`, and `git revert` are intercepted until the workflow reaches `done`. If verification has not passed, Pi asks whether to skip the verification gate for that command; declining blocks the tool call.

## Development

```bash
npm install
npm run typecheck
pi -e ./src/index.ts
```


## CI/CD

GitHub Actions are configured in `.github/workflows/`:

- `ci.yml`: runs on pull requests and pushes to `main`; executes `npm run ci`.
- `release.yml`: runs only for `v*.*.*` tags, verifies and tests the package, publishes to npm, and creates a GitHub Release with generated notes.

Release manually with:

```bash
npm version patch
npm run ci
git push origin main --follow-tags
```

Configure npm Trusted Publishing for this GitHub repository and workflow (`.github/workflows/release.yml`). No `NPM_TOKEN` secret is required; the workflow uses GitHub OIDC with `id-token: write`.
