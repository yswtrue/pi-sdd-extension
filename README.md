# pi-sdd-extension

A session-scoped SDD workflow extension for pi.

## Commands

```text
/sdd:init <feature>  Create SDD artifacts and enable SDD
/sdd:on              Enable SDD for the current session
/sdd:off             Return to the normal workflow
/sdd:status          Show feature, phase, and routing
/sdd:config          Interactively configure SDD defaults
/sdd:agents          Initialize missing default sub-agent definitions
/sdd:approve         Approve the current specification or plan
/sdd:next            Advance after validation
/sdd:verify          Enter verification
```

## Phase routing

Project-local `.pi/sdd.json` controls the executor and model for each phase:

```json
{
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
      "model": "anthropic/claude-opus-4-1"
    },
    "verification": {
      "executor": "subagent",
      "agent": "sdd-verifier"
    }
  }
}
```

`model` uses `provider/model-id`, and is applied to the main Pi session before the phase starts. `/sdd:config` interactively configures the default executor, model, effort, and sub-agent while preserving phase-specific overrides. If `.pi/sdd.json` does not exist, `/sdd:init <feature>` runs the same wizard before creating the feature. For `executor: "subagent"`, the extension instructs the model to call `subagent_run`; configure the actual subagent model in the matching project `.pi/subagents.json` profile:

```json
{
  "model_profiles": {
    "sdd-requirements": { "model": "anthropic/claude-sonnet-4-5", "effort": "low" },
    "sdd-specification": { "model": "anthropic/claude-sonnet-4-5", "effort": "medium" },
    "sdd-verifier": { "model": "openai/gpt-5", "effort": "high" }
  },
  "session_resources": "lean",
  "default_mode": "task"
}
```

This keeps each phase's detailed work in a subagent session and returns only a concise result to the main context. `/sdd:init` creates default agents for requirements, specification, planning, implementation, and verification under `.pi/subagents/`, plus a project `.pi/subagents.json`. Existing definitions are preserved.
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
