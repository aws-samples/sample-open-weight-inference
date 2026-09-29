# Advisor streaming and saved projects

Manual project entry is the primary workflow. The optional Advisor opens on the
right and shares the active project's requirements and evidence.

- **Save project** persists the draft under the signed-in user's identity.
  Browser storage is only a backup; **Download a copy** offers a local export.
- Strands manages the model/tool loop. `Agent.stream_async()` supplies live text
  deltas, forwarded as server-sent events and rendered incrementally.
- A DynamoDB-backed Strands session repository persists messages and tool results.
  Follow-ups restore the same owned conversation; the sliding context window
  bounds model input without claiming that durable history has been deleted.
- Server-side expiry and a per-conversation turn lease prevent expired access and
  concurrent turns from corrupting state. Stop/disconnect requests cancellation;
  cancellation is cooperative, not a promise of instant provider shutdown.
- Partial replies remain visible after interruption. The browser does not
  automatically resubmit a failed turn and repeat tool calls or charges.
- AWS documentation source receipts are saved with each answer. AWS follow-ups
  retrieve documentation again; restored tool history does not count as a fresh
  service check. See [Advisor knowledge sources](advisor-knowledge.md).

The Advisor can propose changes and invoke the same calculators as the manual
workspace. Numerical evidence comes from those results. Generated prose is not
independently verified simply because it mentions a source. A conversation cannot
approve a deployment, grant a capability or supply an authorization identity.

Restored history and project state require working server persistence. Inspect
reported save failures before closing a project. Exported conversations can
contain private requirements and must be handled accordingly.

See [Strands session management](https://strandsagents.com/docs/user-guide/concepts/agents/session-management/),
[streaming](https://strandsagents.com/docs/user-guide/concepts/streaming/) and
[the application security boundaries](security-posture.md).
