# Maximo Agent + MCP (OpenShift)

This repository contains two deployable components:

- **AI Agent App** (`app/`): IBM Carbon React UI + Node.js API layer (AI providers, Maximo REST, MCP orchestration)
- **MCP Server** (`mcp-server/`): Tool server that executes Maximo REST calls and exposes trace UI

## Prerequisites

- OpenShift CLI (`oc`) logged into the target cluster
- A project/namespace you can deploy to (examples use `maximo-ai-agent`)
- OpenShift BuildConfig permissions (binary build)
- Network egress from build pods to public npm registries **or** an internal npm proxy/mirror
- (Recommended) A persistent volume claim for configuration and tenant registry

## 1. Create the OpenShift project

```bash
oc new-project maximo-ai-agent
```

## 2. Create / verify PVC

A single PVC is used for shared configuration (settings + tenant registry).

```bash
oc -n maximo-ai-agent apply -f openshift/pvc.yaml
```

Verify:

```bash
oc -n maximo-ai-agent get pvc
```

## 3. Create Secrets (AI providers + Maximo)

Create a secret containing all keys referenced by the Deployments. Use **empty values** for providers you do not use, but keep the keys present to avoid missing-key startup errors.

Example:

```bash
oc -n maximo-ai-agent create secret generic ai-providers \
  --from-literal=OPENAI_API_KEY="" \
  --from-literal=OPENAI_BASE="https://api.openai.com" \
  --from-literal=MISTRAL_API_KEY="" \
  --from-literal=MISTRAL_BASE="https://api.mistral.ai" \
  --from-literal=ANTHROPIC_API_KEY="" \
  --from-literal=ANTHROPIC_BASE="https://api.anthropic.com" \
  --from-literal=DEEPSEEK_API_KEY="" \
  --from-literal=DEEPSEEK_BASE="" \
  --from-literal=GEMINI_API_KEY="" \
  --from-literal=GEMINI_BASE="" \
  --from-literal=WATSONX_API_KEY="" \
  --from-literal=WATSONX_PROJECT="" \
  --from-literal=WATSONX_BASE="https://us-south.ml.cloud.ibm.com" \
  --dry-run=client -o yaml | oc apply -f -
```

Maximo connection (global default) can be provided by env/secrets:

```bash
oc -n maximo-ai-agent create secret generic maximo-default \
  --from-literal=MAXIMO_URL="https://<your-manage-host>/maximo" \
  --from-literal=MAXIMO_APIKEY="<api-key>" \
  --from-literal=DEFAULT_SITEID="BIKES" \
  --from-literal=DEFAULT_TENANT="default" \
  --dry-run=client -o yaml | oc apply -f -
```

## 4. Deploy build and runtime manifests

Apply the provided OpenShift manifests:

```bash
oc -n maximo-ai-agent apply -f openshift/
```

This creates:
- BuildConfigs for `app` and `mcp-server`
- Deployments + Services + Routes
- PVC mount wiring (settings)

## 5. Build images (binary builds)

From the repository root:

```bash
oc -n maximo-ai-agent start-build app --from-dir=. --follow
oc -n maximo-ai-agent start-build mcp-server --from-dir=. --follow
```

If your cluster build pods cannot reach the public npm registry, configure `.npmrc` to point to your internal proxy and rebuild.

## 6. Rollout / verify

```bash
oc -n maximo-ai-agent rollout status deploy/app
oc -n maximo-ai-agent rollout status deploy/mcp-server
oc -n maximo-ai-agent get routes
```

## 7. Configure the AI Agent to use MCP (recommended in-cluster URL)

In the **AI Agent UI → Settings**:

- **Enable MCP tool orchestration**
- **MCP Server URL**: use the internal service URL to avoid TLS/self-signed issues:

  - `http://mcp-server:8081`

## 8. Tenant registry and settings.json on PVC

The settings file is stored at:

- `/opt/app-root/settings/settings.json` (mounted from PVC)

A minimal example:

```json
{
  "ui": { "theme": "g10" },
  "mcp": { "enableTools": true, "url": "http://mcp-server:8081" },
  "maximo": { "defaultTenant": "default", "defaultSite": "BIKES" },
  "tenants": [
    { "id": "default", "label": "Default", "maximoBaseUrl": "https://<host>/maximo", "org": "EAM", "site": "BIKES" }
  ]
}
```

Provider API keys are **not** written to the PVC in the recommended “secrets override PVC” model.

## 9. Troubleshooting

### MCP tools must be OpenAI-ready
From inside the cluster:

```bash
oc -n maximo-ai-agent run curltest --rm -i --restart=Never --image=curlimages/curl -- \
  sh -lc 'curl -sS http://mcp-server:8081/mcp/tools?tenant=default | head -c 300'
```

Expected prefix:

```json
{"tools":[{"type":"function","function":{"name":
```

### AI provider 422 on tools
If you see 422 complaining about missing `tools[0].function`, your deployed images are stale. Rebuild both BuildConfigs and restart both Deployments.

## UI Styling Notes

- Navigation pane background is **black** with **white** font (both UIs)
- Data tables use Carbon tokens for readable colors in light/dark themes
