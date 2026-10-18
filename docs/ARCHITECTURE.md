# Architecture

The plugin ships directly as JavaScript. There is no bundling step.

| File | Responsibility |
| :--- | :--- |
| `lib/index.js` | Host config, turn tracking, context redaction, routing, deduplication, timeouts, HTTP endpoints. |
| `lib/client.js` | Browser loader entry, dock, draft insertion, settings, English/Chinese dictionaries. |
| `cordis.patch.yml` | Inserts the plugin loader row into the DSH composition. |
| `locale/*.json` | Plugin-manager metadata. |

## Public DSH extension points

| Purpose | API |
| :--- | :--- |
| Composer dock | `ctx.slots.inject('conversation.input.dock')` |
| Read draft | Dock `input.draft` and session-scoped input hooks. |
| Insert draft | `inputActions.setDraft(text)` |
| Return focus | `ctx.conversation.input.shell(sessionId).focus()` |
| Detect completion | Client `session.running` transition; host `session/event` with `turn/end` validation. |
| Model request | `ctx.llm.stream({ provider, model, messages, maxTokens: 150, signal })` |
| Host communication | `ctx.webServer.register`, guarded by `ctx.connection.requestRejection`. |
| Settings | Volatile host `Config` fields, `ctx.configForms`, and plugin/settings slots. |
| Localization | `ctx.locale.register` |

Same-origin HTTP routes live under `/dsh-next-suggestion`. The package does not ship generated Typert `/remote` descriptors. Provider requests originate in the host.

## Prediction lifecycle

1. The host records user turns, completions, selections, and open todos in memory.
2. The client observes a turn finishing while its draft is empty.
3. The host validates completion and builds a limited text context. Fewer than two user turns produces no prediction.
4. Routing selects a configured model. In-flight deduplication and cached responses avoid duplicate calls for a tracked completion.
5. The model is prompted for JSON. The host filters generic, oversized, repeated, and dismissed candidates.
6. The client renders the text candidates. A click sets a draft and restores focus.

There is a 1.5-second client display window and a configurable host timeout. Cancellation is propagated through an abort signal; provider-side cancellation and billing depend on the provider.

## Verification scope

`npm test` covers host behavior and React client interactions with a simulated DSH host and DOM, including an actual host response rendered by the client. GitHub Actions runs the suite on Windows and Linux with Node 22.19 and 24. These checks do not certify live model quality or every DSH installation.

See the [README](../README.md) for compatibility and data boundaries.
