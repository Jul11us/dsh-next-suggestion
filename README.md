<p align="right"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

![Next instruction suggestions. A quieter way to keep moving.](docs/readme/cover.png)

<p align="center">
<a href="https://github.com/Jul11us/dsh-next-suggestion/releases/latest">Download</a> ·
<a href="#getting-started">Get started</a> ·
<a href="docs/ARCHITECTURE.md">Under the hood</a> ·
<a href="LICENSE">MIT license</a>
</p>

# Next instruction suggestions

**The next step, without breaking your flow.**

A small, considered plugin for **DeepSeek DSH**. When an assistant finishes a turn, it offers up to three concrete next instructions above the composer. Choose one, refine it, and send it when you are ready.

Suggestions are optional. **A click fills your draft; it never sends a message or runs an action.**

---

### Less friction. More intention.

| A little help | A clear boundary |
| :--- | :--- |
| **Relevant next steps** | Uses recent conversation text and open todos to propose short, concrete instructions. |
| **Your words, your decision** | One click fills the composer and returns focus. Edit before sending. |
| **Quiet by design** | Hides as you type, open the command menu, change sessions, or press Escape in the composer. Results arriving after 1.5 seconds are discarded. |
| **A lighter model preference** | Auto mode favors names such as `flash`, `mini`, and `lite`. This is a naming heuristic, not a live price comparison. |
| **Small, explicit context** | Sends limited text to a provider configured in DSH, with common secret patterns and path usernames redacted. |

![Illustrative suggestion dock and composer with example content.](docs/readme/preview.png)

<p align="center"><sub>Illustrative interface with example content. Actual appearance follows your DSH theme.</sub></p>

### A simple rhythm

1. **Finish a turn.** Leave the composer empty after the assistant responds.
2. **Choose a direction.** Pick a suggestion, or dismiss it with `×`.
3. **Make it yours.** Review the draft, edit freely, and send it yourself.

The plugin waits for at least two user turns. Thin context or greetings may produce no suggestions. Dismissed suggestions are filtered in page memory, capped at 20 entries per session across 50 tracked browser sessions.

## Getting started

**Requirements:** Node.js **22.19 or later**, DeepSeek DSH **`>=0.2.1-rc.2 <0.3.0`**, a Web GUI or Desktop client, and a configured model provider. The original development baseline was DSH `0.2.1-rc.2`; the full range has not been tested against every release.

### Install the release package

1. Download [`dsh-next-suggestion-0.1.0.tgz`](https://github.com/Jul11us/dsh-next-suggestion/releases/download/v0.1.0/dsh-next-suggestion-0.1.0.tgz), or copy its download URL.
2. In DSH, open **Plugins → Add plugin / Install third-party plugin** and enter the `.tgz` download URL in the package field.
3. Enable **Next instruction suggestions**, restart DSH, then refresh the client.

If your installer does not accept an archive URL, extract the archive and install the inner `package` directory as a local plugin.

### Install from source

```sh
git clone https://github.com/Jul11us/dsh-next-suggestion.git
cd dsh-next-suggestion
npm ci --ignore-scripts
```

Add the cloned directory through DSH's local plugin installer, enable the bundle, restart DSH, and refresh the client. A desktop-profile CLI alternative is:

```text
dsh plugin --profile desktop add "file:C:\path\to\dsh-next-suggestion"
```

This version is distributed through GitHub Release. These installation methods do not require an npm registry publication.

## Tune the experience

Open **Plugins → Next instruction suggestions → Configure**, or **Settings → Next suggestions**.

| Setting | Default | Purpose |
| :--- | :--- | :--- |
| Enable predictions | On | Turning this off stops new prediction calls. |
| Candidates | `3` | Show between one and three suggestions. |
| Provider / model | Empty | Auto-select a route, or specify your preferred provider and model. |
| Host timeout | `8000 ms` | Bound the host request; the interface still has a 1.5-second display window. |
| Debug details | Off | Show token counts, latency, and call count. |

Automatic routing prefers models with lightweight names. When it falls back to a reasoning or expensive-looking model, it allows at most one prediction per tracked session. A provider-only setting stays within that provider; a model-only setting resolves that exact model. Choosing both overrides automatic routing. Prediction calls can consume provider credits.

## Context, with limits

The plugin may send the session title, up to six open todos, and up to six recent user/assistant turns to your configured provider. Assistant prose is shortened and fenced code blocks are replaced with `[code]`. User message text can still contain pasted code or sensitive material.

Common API-key/token patterns, bearer strings, long base64 content, and usernames in common home-directory paths are redacted before the request. **Redaction is best effort; it cannot recognize every secret or personal detail.** Review the provider you select and the conversation you use it with.

The plugin does not separately read file contents, attachment bodies, or tool-output bodies into its prompt. It adds no analytics endpoint and does not write prediction context to disk. In-memory state is cleared on reload or host restart as appropriate; DSH and your provider have their own storage behavior.

## Built to be understood

Two small JavaScript modules, public DSH extension points, and no build step. The host tracks turns and prepares model calls; the client renders suggestions and edits the draft. No core patches are required.

- [Architecture and extension points](docs/ARCHITECTURE.md)
- [Publishing guide](PUBLISHING.md)
- [Host tests](https://github.com/Jul11us/dsh-next-suggestion/blob/main/test/host.test.mjs) · [Client tests](https://github.com/Jul11us/dsh-next-suggestion/blob/main/test/client.test.mjs)

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

Tests exercise host behavior and client interactions with test doubles. They do not certify every DSH version, live model response, or installer path. A slow provider, incomplete turn, insufficient context, or unavailable settings service can leave the dock empty.

---

An independent community plugin for DeepSeek DSH. [MIT licensed](LICENSE).
