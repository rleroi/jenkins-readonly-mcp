# jenkins-readonly-mcp

A small, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for Jenkins.
It lets an MCP client (Claude Code, Claude Desktop, ...) inspect failed builds, failing tests,
latest builds and deployments. It only ever issues HTTP `GET` requests, so it cannot trigger,
abort, or change anything in Jenkins.

## Tools

| Tool | Purpose |
|---|---|
| `get_failing_overview` | Scan a folder tree for jobs whose last build is red/unstable ("what is broken right now?") |
| `list_jobs` | Browse folders, jobs and multibranch branches with last build result |
| `get_latest_builds` | Latest N builds of a job (result, duration, cause, commits) |
| `get_failed_builds` | Recent failed/unstable (optionally aborted) builds of a job |
| `get_build` | Details of one build (default: last build) |
| `get_build_stages` | Pipeline stages with status, shows which stage failed |
| `get_test_report` | Failed tests from the JUnit report, if the job publishes one |
| `get_console_failures` | Grep the console log for PHPUnit/Pest/Jest/etc. failures, for pipelines without a JUnit report |
| `get_console_tail` | Last N lines of the console log (credential-like values are masked) |
| `get_deploys` | Latest deploy builds per environment folder (`<app>/{Acceptance,Staging,Production}`) |

Jobs are addressed by slash-separated path, e.g. `MyFolder/MyApp/Build/main`.
Branch names returned by `list_jobs` (e.g. `feature%2Ffoo`) can be passed back as-is.

> `get_deploys` assumes deploy jobs live in sibling folders named after the environment.
> Pass `environments` to use other folder names.

## Requirements

- Node.js 18 or newer
- A Jenkins user with **read** permission and an API token

## Installation

```bash
git clone <this-repo-url> jenkins-readonly-mcp
cd jenkins-readonly-mcp
npm install
```

### Create a Jenkins API token

1. Log in to Jenkins.
2. Click your name (top right) -> **Security** (`<jenkins-url>/me/security`).
3. Under **API Token** click **Add new Token**, name it, and **Generate**.
4. Copy the token right away; Jenkins shows it only once.

Use a dedicated token for this server so you can revoke it independently. Ideally use a user
that only has read permissions.

### Configuration

The server reads three environment variables (all required):

| Variable | Example |
|---|---|
| `JENKINS_URL` | `https://jenkins.example.com` |
| `JENKINS_USER` | `your-username` |
| `JENKINS_TOKEN` | the API token from above |

Never commit the token. This repository's `.gitignore` excludes `.env` files.

### Register with Claude Code

```bash
claude mcp add jenkins -s user \
  -e JENKINS_URL=https://jenkins.example.com \
  -e JENKINS_USER=your-username \
  -e JENKINS_TOKEN=your-token \
  -- node /absolute/path/to/jenkins-readonly-mcp/server.mjs
```

Restart Claude Code and run `/mcp` to verify that `jenkins` is connected.

> `claude mcp add` stores the token in `~/.claude.json`. Keep that file private.

### Register with Claude Desktop (or any other MCP client)

Add to the client's MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "node",
      "args": ["/absolute/path/to/jenkins-readonly-mcp/server.mjs"],
      "env": {
        "JENKINS_URL": "https://jenkins.example.com",
        "JENKINS_USER": "your-username",
        "JENKINS_TOKEN": "your-token"
      }
    }
  }
}
```

## Example prompts

- "What is failing in Jenkins right now under `MyFolder`?"
- "Why did the last build of `MyFolder/MyApp/Build/main` fail? Which stage and which tests?"
- "Show the latest deploys for `MyFolder/MyApp`."

## Quick smoke test

```bash
JENKINS_URL=https://jenkins.example.com JENKINS_USER=you JENKINS_TOKEN=... \
  npx @modelcontextprotocol/inspector node server.mjs
```

## Security notes

- Read-only by design: there is no code path that sends anything other than `GET`.
- Console output is returned with `password/secret/token/api key = value` patterns masked, but
  console logs can still contain sensitive data. Treat tool output as sensitive.
- Build parameters whose name contains `pass`, `token`, `secret` or `key` are omitted.

## License

MIT
