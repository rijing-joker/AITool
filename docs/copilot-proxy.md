# Connect Copilot to AiTool

Open **AI Proxy → Keys**, choose a configured client key and model, select the
Copilot client, then connect. The proxy must be running for model discovery and
subsequent requests. Discovery connects directly to `127.0.0.1`, even when an
outbound HTTP proxy is configured.

## GitHub Copilot CLI

AiTool writes its own `~/.copilot/aitool-connection.json` (or under an absolute
`COPILOT_HOME`). It does not alter Copilot's native user settings. Start the
connected client through:

```sh
aitool copilot
aitool copilot --resume
```

The launcher forwards arguments and exit status. It supplies the selected
OpenAI chat-completions endpoint, key and model through process environment
variables, clearing conflicting provider overrides. The key is not passed as a
command-line argument. On Windows, supported npm launchers are resolved to their
fixed script/executable target so prompts containing shell characters remain
literal arguments.

The local connection and backups contain the client key and are written with
owner-only file permissions where supported. Restore removes only AiTool's
provider fields and preserves other fields added after connection.

## VS Code Copilot Chat

The standard VS Code profile's `Code/User/chatLanguageModels.json` receives an
`AiTool` custom-endpoint group. Other provider groups are preserved. AiTool
launches a temporary extension development window to ask Copilot Chat's native
`lm.addLanguageModelsProviderGroup` command to store the credential. Complete
any native authentication/confirmation in that window; it closes after setup.
The persistent model configuration contains a native secret reference rather
than the plaintext key.

The handoff uses private temporary files, a per-run nonce and a two-minute
expiry. Plaintext handoff files are removed after setup or failure. No extension
is installed, and AiTool does not read VS Code's encrypted credential database.

Setup requires Copilot Chat, enabled AI features, a supported native command and
a clean model configuration editor. Custom VS Code profiles/alternate editor
builds are not supported by this path. A cached secret reference is reused for
the same key; changing the key runs native setup again.

The dashboard currently discovers model IDs. VS Code models default to a
128,000-token context window, tool calling enabled and vision disabled; the
backend accepts explicit context/vision metadata for callers that have it.
These defaults are configuration assumptions, not detected provider limits.

## Restore and validation

The first configuration is retained as a baseline, with up to 20 recent
backups. Restore checks the owned provider fields before changing them and
reports a conflict if they were edited outside AiTool. A write-ahead journal
allows recovery after an interrupted target replacement. Restoring the model
configuration does not delete credentials from VS Code's native secret store.

Regression coverage uses temporary homes, a fixture HTTP server and mocked CLI
and VS Code command APIs. Native VS Code setup and live Copilot requests still
require manual validation on a machine with those clients installed.
