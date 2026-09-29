# Advisor knowledge sources

The Advisor combines decision methods with current documentation and project
evidence. Each source has a different purpose.

| Source | Used for | Does not establish |
| --- | --- | --- |
| Packaged `SKILL.md` files | Qualification, evaluation design, routing questions, sizing methods and operating procedures | Current AWS support, this project's performance or deployment approval |
| AWS Knowledge MCP | Live retrieval of official AWS documentation for service capabilities, requirements and billing rules | Account access, available capacity, actual rates or a successful benchmark |
| Application tools | AWS prices, account catalogs, exact model inspection, calculations and solver results | Permission to relax a failed check |
| Versioned experiment records | The configuration and observations of a particular measured run | Performance of a different model or workload |

## How a turn works

The native Strands model/tool loop first selects relevant public documentation
topics. Bedrock tool choice requires this step before the first answer. A greeting,
simple project edit or general principle can select no topics and makes no network
call. AWS questions, including follow-ups, retrieve documentation again in that
turn. Only repeated reads within the same turn reuse a result.

The MCP search returns page excerpts. The Advisor can request a fuller section by
its returned source ID when detail is missing. It then uses the skill library and
existing project tools as needed, citing the documentation in its answer. Ordinary
answer text continues to stream directly from Strands.

An **AWS documentation retrieved** receipt shows the actual pages and retrieval
time. It describes retrieval, not independent verification of every sentence the
model writes. Receipts and native tool results are saved in the existing scoped
DynamoDB conversation and restored after a refresh. The timestamp is not a page's
publication date.

When retrieval fails, is disabled, or finds no matching page, the affected check
stays unverified. A failed detail read is shown as incomplete even if its search
excerpt was retrieved. The Advisor can explain stable principles and known project
facts, but must not replace missing AWS documentation with remembered limits or
old skill content. No failed turn is automatically resubmitted.

## Connection and operator control

The runtime connects to the official
[AWS Knowledge MCP server](https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server)
at `https://knowledge-mcp.global.api.aws`, using the MCP SDK's Streamable HTTP
client. It does not start a local server or invoke a subprocess. The MCP and HTTP
client versions are pinned in `backend/runtime-requirements.txt`.

The CloudFormation parameter `AwsDocumentationEnabled` defaults to `true`.
For the installer, set `EDDIE_AWS_DOCS_ENABLED=false` to disable the connection, or
`true` to enable it. Redeploy to apply that setting. The health endpoint reports
configuration only; successful retrieval is reported with the individual answer.
No extra IAM permission is required by this unauthenticated public endpoint.
The optional COA connector remains independent.

## Data and security boundaries

- Only predefined public topic queries and source URLs returned in that turn are
  sent. User messages, model identifiers, project payloads, AWS account IDs and
  authentication tokens cannot be passed as query parameters.
- The transport accepts only the exact HTTPS MCP endpoint. It refuses redirects,
  credentials, cookies, alternate hosts and paths, and environment proxies.
- Only documentation search and read are callable. Remote tools are not
  automatically discovered or registered with the Advisor. No local roots,
  sampling, elicitation or credential callbacks are provided to the MCP server.
- A turn can consult three topics and read two additional bounded sections.
  Requests have a timeout and streamed response-size limits. Stop cancels the
  active documentation operation and closes its client.
- Excerpts are untrusted reference text. Documentation tools have no project-write
  or deployment capability. They cannot grant authority, register additional tools
  or clear solver gates. Existing application tools retain their server-side
  authentication, tenancy and approval checks. The Advisor is instructed to ignore
  instructions within retrieved text; this is not a claim that model-written
  explanations are immune to prompt injection or factual mistakes.
- The browser renders escaped text and validated AWS documentation links. Raw MCP
  responses, tool arguments and credentials are not exposed in progress events or
  the source receipt.

Topic selection is a model decision over a fixed vocabulary. Documentation can
still be incomplete or ambiguous; an unavailable topic or missing exact-model
answer must remain unresolved. Review this new outbound connection and its tests
as part of the sample's security review before publication.
