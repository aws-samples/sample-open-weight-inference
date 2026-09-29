# Advisor skills

Each skill has one `SKILL.md` with `name` and `description` frontmatter, followed by
its decision procedure. The application searches `catalog.json`, reads up to three
selected skills, and adds `references/decision-contract.md`. `sources.json` records
citations and editorial review dates.

```text
backend/knowledge/
  aws_doc_topics.py              Public AWS documentation search topics
  aws_docs.py                    Bounded, read-only AWS Knowledge MCP client
  runbooks.py                    Existing retrieval API and local skill loader
  skills/
    catalog.json                Discovery metadata and content digests
    sources.json                Cited references and review dates
    references/
      decision-contract.md      Shared evidence and authorization rules
    qualify-inference-workload/
      SKILL.md                  One focused procedure
    ...                         51 other skill directories
```

This follows the [Agent Skills format](https://agentskills.io/specification),
[OpenAI guidance](https://learn.chatgpt.com/docs/build-skills) and
[Anthropic guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview):
small metadata for discovery, instructions when needed, additional references only
when useful. None requires a separate `RUNBOOK.md` for every skill.

The directory is application data packaged with the runtime. Codex discovers
repository skills under `.agents/skills`; Claude Code uses `.claude/skills`.
Those are client-specific discovery locations, not required locations for this
Strands application. These skills refer to EDDIE's tools and are not standalone
permissions or a replacement for its system prompt. A root `AGENTS.md` would guide
coding agents, not configure the deployed Advisor.

Keep decision methods here. Retrieve changing AWS capabilities through AWS
Knowledge MCP, prices and account facts through application APIs, and experiment
figures from their versioned evidence records. The legacy `find_runbooks` and
`read_runbooks` tool names remain compatible with saved conversations.

See [maintenance and the skill index](../../../docs/inference-runbooks.md).
