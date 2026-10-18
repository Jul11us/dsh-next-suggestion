# Architecture

The plugin ships directly as JavaScript. There is no bundling step.

| File | Responsibility |
| :--- | :--- |
| `lib/index.js` | Host config, turn tracking, state packet, context redaction, routing, candidate ranking, deduplication, timeouts, HTTP endpoints. |
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

1. The host records user turns, completions, selections, open todos, tool calls/results, job outcomes, changed files, goal/plan state, and the assistant's open question in memory.
2. The client observes a turn finishing while its draft is empty.
3. The host validates completion and builds a limited text context plus a compact state packet. It does not separately load full tool outputs, attachment bodies, or file contents; command text and conversation/goal/todo labels can still contain pasted material. Fewer than two user turns produces no prediction.
4. Routing selects a configured model. In-flight deduplication and cached responses avoid duplicate calls for a tracked completion.
5. The model is asked for up to five JSON candidates. The host parses them, then a local ranker selects at most three using grounding (file/test/command/function in the state), fit to the open question, a state prior (favor commit after a completed run with changes; favor fixes after failed actions), and intent diversity. Generic, oversized, repeated, and dismissed candidates are dropped.
6. The client renders the ranked text candidates. A click sets a draft and restores focus.

There is a 1.5-second client display window and a configurable host timeout. Cancellation is propagated through an abort signal; provider-side cancellation and billing depend on the provider.

## Verification scope

`npm test` covers 28 host checks and 8 client checks with a simulated DSH host and DOM, including the state packet, ranking, open-question code filtering, job-failure ordering, and an actual host response rendered by the client. GitHub Actions runs the suite on Windows and Linux with Node 22.19 and 24.

`scripts/export-golden.mjs` turns a real session log into replay cases (text and tool metadata only); `scripts/eval-replay.mjs` reuses the shipped prompt, parser, and ranker and reports top-1/top-3 similarity against the message that actually followed the turn. It can score through any OpenAI-compatible endpoint or replay recorded answers. These checks do not certify live model quality or every DSH installation.

See the [README](../README.md) for compatibility and data boundaries.
