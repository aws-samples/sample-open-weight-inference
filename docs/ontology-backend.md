# Optional ontology context

[Context Ontology Accelerator (COA)](https://github.com/aws/context-ontology-accelerator)
can provide governed vocabulary and reference context. EDDIE includes an MCP
adapter; the default installation does not deploy COA infrastructure. With no
endpoint configured, the integration reports **Not installed**, and comparison
continues to work.

The bundled [inference runbooks](inference-runbooks.md) provide local decision
guidance independently of COA. They require no ontology infrastructure.

The adapter in `backend/knowledge/coa.py` supports COA's `list_metrics`,
`describe_schema`, `query`, `translate_sparql`, `rag_retrieval` and
`graph_traversal` tools. Context is supplementary explanation. It cannot supply an
authoritative price, satisfy a feasibility gate or approve a deployment.

## Configure an existing installation

An operator can supply the application template's `CoaMcpEndpoint` parameter and
configure the permitted namespace and compatible authorization. The connector
forwards the caller's bearer token to that HTTPS endpoint. Establish trust in the
endpoint and its user/namespace authorization before enabling it. A configured
URL does not prove the remote service is healthy or that access is authorized.

Keep retrieved documents untrusted: instructions in a model card or graph comment
must not change permissions or override the solver. Private context must not be
promoted into shared public evidence.

The optional Neptune/ECS parameters support restricted sleep/wake operations for
an existing COA environment. They do not install it, eliminate all standing costs
or replace its security and lifecycle review. See [costs](cost-budget.md) and
[security settings](security-posture.md).
