window.__ModuleLoader__.load({
  id: "dsh-next-suggestion",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = "next-suggestion";
    // Host routes are absolute; browser fetches stay document-relative (the
    // shell sets <base href="./">), matching the shipped open-in-app package.
    const PREDICT_PATH = "dsh-next-suggestion/predict";
    const MODELS_PATH = "dsh-next-suggestion/models";
    const STRIP_TIMEOUT_MS = 1500;
    const MAX_DISMISSED_PER_SESSION = 20;

    const DEFAULT_CONFIG = Object.freeze({
      enabled: true,
      maxCandidates: 3,
      provider: "",
      model: "",
      timeoutMs: 8000,
      debug: false,
    });

    const DICT = {
      en: {
        "dock.label": "Next instruction suggestions",
        "dock.lead": "Next?",
        "dock.dismiss": "Not this time",
        "dock.debug": "{tokens} tok · {seconds}s · {calls} call",
        "settings.nav": "Next suggestions",
        "settings.title": "Next instruction suggestions",
        "settings.description":
          "Show 1-3 concrete one-click drafts above the composer after a turn ends and the draft is empty. Clicking a draft only fills the composer; it never sends.",
        "settings.enabled": "Enable predictions",
        "settings.enabledHint": "When off, no prediction request is sent.",
        "settings.count": "Candidates",
        "settings.countHint": "How many suggestions to show at most (1-3).",
        "settings.provider": "Provider",
        "settings.providerHint": "Leave both provider and model empty to auto-select a cheap model.",
        "settings.model": "Model",
        "settings.modelHint": "Model id offered by the selected provider.",
        "settings.timeout": "Host timeout (ms)",
        "settings.timeoutHint": "Hard limit for one Host-side model call. The strip hides after 1.5 s regardless.",
        "settings.debug": "Debug details",
        "settings.debugHint": "Show token count and latency in the corner of the strip.",
        "settings.save": "Save",
        "settings.saving": "Saving…",
        "settings.saved": "Saved",
        "settings.reset": "Reset to defaults",
        "settings.error": "Could not save. Try again.",
        "settings.loading": "Loading settings…",
        "settings.unavailable": "Settings are unavailable in this composition.",
        "settings.noteCheap":
          "Auto mode prefers a cheap flash/mini/chat model. If only a reasoning or expensive model is available, this session gets at most one prediction, and the settings stay in effect for the next session.",
        "settings.noteData":
          "Only the session title, open todos, and recent user/assistant text go to your configured provider. Common secret patterns, base64 blobs, and usernames in standard home paths are redacted on a best-effort basis. This plugin does not persist prediction context or add telemetry; your provider's retention policy still applies.",
      },
      zh: {
        "dock.label": "下一条指令建议",
        "dock.lead": "下一步？",
        "dock.dismiss": "这次不用",
        "dock.debug": "{tokens} tok · {seconds} 秒 · {calls} 次调用",
        "settings.nav": "下一条指令",
        "settings.title": "下一条指令预测",
        "settings.description":
          "助手回合结束且输入框为空时，在输入框上方显示 1-3 条可直接填入的具体指令。点击只填入草稿，绝不自动发送。",
        "settings.enabled": "启用预测",
        "settings.enabledHint": "关闭后不会发出任何预测请求。",
        "settings.count": "候选条数",
        "settings.countHint": "最多显示几条（1-3）。",
        "settings.provider": "提供方",
        "settings.providerHint": "提供方和模型都留空时自动选择便宜模型。",
        "settings.model": "模型",
        "settings.modelHint": "所选提供方提供的模型 id。",
        "settings.timeout": "宿主超时（毫秒）",
        "settings.timeoutHint": "单次宿主模型调用的硬上限；浮层本身 1.5 秒没结果就不显示。",
        "settings.debug": "调试模式",
        "settings.debugHint": "在浮层角落显示这次调用的 token 数和耗时。",
        "settings.save": "保存",
        "settings.saving": "保存中…",
        "settings.saved": "已保存",
        "settings.reset": "恢复默认",
        "settings.error": "保存失败，请重试。",
        "settings.loading": "正在读取设置…",
        "settings.unavailable": "当前组合没有提供设置服务。",
        "settings.noteCheap":
          "自动模式优先选择 flash / mini / chat 这类便宜模型。如果当前只有推理型或昂贵模型，本次会话最多预测一次，之后不再预测；该限制对新会话重新计算。",
        "settings.noteData":
          "只把会话标题、未完成 todo 和最近几轮用户/助手文本发给你配置的 provider；发送前尽力清洗常见密钥格式、base64 大块及标准主目录路径中的用户名。插件不保存预测上下文、不添加遥测；服务商的数据保留策略仍然适用。",
      },
    };

    const CSS = `
.dns-strip{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance, 0px) - var(--dsh-composer-side-clearance, 0px));max-width:var(--dsh-composer-card-max-width, 760px);margin:0 auto 6px;padding:1px 2px;display:flex;align-items:center;gap:6px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;pointer-events:none;color:var(--dsw-alias-label-tertiary, #8b8b8b);font-size:12px;line-height:20px;opacity:.92}
.dns-strip::-webkit-scrollbar{display:none}
.dns-lead{flex:none;padding:0 2px;font-size:11px;letter-spacing:.02em;opacity:.72;user-select:none}
.dns-chip{flex:none;display:inline-flex;align-items:center;gap:2px;max-width:min(46vw, 360px);padding:1px 1px 1px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18));background:var(--dsw-alias-bg-module-platform, rgba(127,127,127,.07));pointer-events:auto}
.dns-chip:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.13))}
.dns-chip-text{appearance:none;border:0;background:transparent;color:inherit;font:inherit;padding:1px 2px;margin:0;max-width:min(40vw, 320px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.dns-chip-text:focus-visible,.dns-chip-x:focus-visible{outline:1px solid var(--dsw-alias-label-secondary, #666);outline-offset:1px;border-radius:999px}
.dns-chip-x{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;padding:0 5px;margin:0;border-radius:999px;cursor:pointer;opacity:.55}
.dns-chip-x:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.13))}
.dns-meta{flex:none;margin-left:auto;padding:0 4px;font-size:10.5px;font-variant-numeric:tabular-nums;opacity:.62;white-space:nowrap}
.dns-settings{display:flex;flex-direction:column;gap:18px;padding:4px 0 8px;color:var(--dsw-alias-label-primary, inherit);font-size:13px;line-height:20px}
.dns-settings-head{display:flex;flex-direction:column;gap:4px}
.dns-settings-title{font-size:15px;line-height:24px;font-weight:500}
.dns-settings-desc{color:var(--dsw-alias-label-tertiary, #8b8b8b);font-size:12px;line-height:18px;max-width:640px}
.dns-row{display:flex;align-items:flex-start;gap:16px;justify-content:space-between}
.dns-row-text{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;padding-right:12px}
.dns-row-label{font-size:13px;line-height:20px}
.dns-row-hint{color:var(--dsw-alias-label-tertiary, #8b8b8b);font-size:12px;line-height:18px}
.dns-row-control{flex:none;display:flex;align-items:center;gap:8px;padding-top:1px}
.dns-input{box-sizing:border-box;height:32px;min-width:200px;padding:0 10px;border-radius:var(--dsw-radius-md, 8px);border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2));background:var(--dsw-alias-bg-module-platform, transparent);color:inherit;font:inherit;font-size:13px}
.dns-input:focus{outline:1px solid var(--dsw-alias-label-secondary, #666);outline-offset:0}
.dns-input-small{min-width:88px;width:110px}
.dns-select{height:32px;padding:0 8px;border-radius:var(--dsw-radius-md, 8px);border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2));background:var(--dsw-alias-bg-module-platform, transparent);color:inherit;font:inherit;font-size:13px}
.dns-switch{appearance:none;position:relative;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25));background:var(--dsw-alias-bg-module-platform, rgba(127,127,127,.12));cursor:pointer;transition:background .15s ease}
.dns-switch:checked{background:var(--dsw-alias-label-primary, #333);border-color:transparent}
.dns-switch:after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.dns-switch:checked:after{transform:translateX(14px)}
.dns-actions{display:flex;align-items:center;gap:10px}
.dns-button{appearance:none;border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2));background:var(--dsw-alias-bg-module-platform, transparent);color:inherit;font:inherit;font-size:13px;line-height:20px;padding:5px 12px;border-radius:var(--dsw-radius-md, 8px);cursor:pointer}
.dns-button:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))}
.dns-button-primary{background:var(--dsw-alias-label-primary, #333);border-color:transparent;color:var(--dsw-alias-bg-module-platform, #fff)}
.dns-button-primary:hover{opacity:.9}
.dns-button:disabled{opacity:.5;cursor:default}
.dns-status{font-size:12px;color:var(--dsw-alias-label-tertiary, #8b8b8b);min-height:18px}
.dns-note{color:var(--dsw-alias-label-tertiary, #8b8b8b);font-size:12px;line-height:18px;max-width:640px;border-top:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.14));padding-top:12px}
.dns-loading{color:var(--dsw-alias-label-tertiary, #8b8b8b);font-size:12px;padding:8px 0}
`;

    /** In-memory dismissal memory, kept per browser Session id. */
    const dismissedBySession = new Map();

    function dismissedFor(sessionId) {
      return dismissedBySession.get(String(sessionId || "")) || [];
    }

    function rememberDismissed(sessionId, text) {
      const key = String(sessionId || "");
      const current = dismissedBySession.get(key) || [];
      if (!current.some((item) => similar(item, text))) current.push(text);
      while (current.length > MAX_DISMISSED_PER_SESSION) current.shift();
      dismissedBySession.set(key, current);
      if (dismissedBySession.size > 50) {
        const oldest = dismissedBySession.keys().next().value;
        if (oldest !== undefined && oldest !== key) dismissedBySession.delete(oldest);
      }
    }

    function isDismissed(sessionId, text) {
      return dismissedFor(sessionId).some((item) => similar(item, text));
    }

    function normalizeForCompare(text) {
      return String(text || "")
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, "");
    }

    function bigrams(text) {
      const out = new Set();
      for (let index = 0; index < text.length - 1; index += 1) out.add(text.slice(index, index + 2));
      return out;
    }

    function similar(left, right) {
      const a = normalizeForCompare(left);
      const b = normalizeForCompare(right);
      if (!a || !b) return false;
      if (a === b) return true;
      const shorter = Math.min(a.length, b.length);
      const longer = Math.max(a.length, b.length);
      if (shorter >= 4 && (a.includes(b) || b.includes(a)) && shorter / longer >= 0.6) return true;
      const ba = bigrams(a);
      const bb = bigrams(b);
      if (ba.size === 0 || bb.size === 0) return false;
      let shared = 0;
      for (const gram of ba) if (bb.has(gram)) shared += 1;
      return shared / (ba.size + bb.size - shared) >= 0.68;
    }

    function clampInt(value, min, max, fallback) {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(number)));
    }

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-dsh-plugin="dsh-next-suggestion"]')) return;
      const tag = document.createElement("style");
      tag.dataset.dshPlugin = "dsh-next-suggestion";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() =>
        form ? form.getSnapshot() : { status: "unavailable", value: undefined, revision: undefined },
      );
      React.useEffect(() => {
        if (!form) return undefined;
        setSnapshot(form.getSnapshot());
        return form.subscribe(() => setSnapshot(form.getSnapshot()));
      }, [form]);
      return snapshot;
    }

    async function requestPrediction(body, signal) {
      const response = await fetch(PREDICT_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) return null;
      return response.json();
    }

    async function requestModels(signal) {
      const response = await fetch(MODELS_PATH, { credentials: "same-origin", signal });
      if (!response.ok) return { providers: [] };
      const data = await response.json();
      return data && Array.isArray(data.providers) ? data : { providers: [] };
    }

    function focusComposer(ctx, sessionId) {
      try {
        const conversation = ctx.conversation || ctx.get?.("conversation");
        conversation?.input?.shell?.(sessionId)?.focus?.();
        return;
      } catch {
        /* fall through to the DOM focus below */
      }
      try {
        const editor = document.querySelector('[data-composer-card] [contenteditable="true"]');
        editor?.focus?.({ preventScroll: true });
      } catch {
        /* focus is best-effort */
      }
    }

    const useNoStore = () => undefined;

    function NextSuggestionDock(props) {
      const {
        session: sessionProp,
        input: inputProp,
        inputActions,
        t,
        form,
        requestPrediction: predict,
        focusComposer: focus,
        useSession,
        useInput,
      } = props;
      // Session-scoped slots publish these hooks; fall back to the owner props
      // so the dock also works when rendered by an embedded occurrence.
      const session = (useSession || useNoStore)((value) => value) ?? sessionProp;
      const input = (useInput || useNoStore)((value) => value) ?? inputProp;
      const sessionId = session?.sessionId;
      const snapshot = useFormSnapshot(form);
      const config =
        snapshot.status === "ready" && snapshot.value ? { ...DEFAULT_CONFIG, ...snapshot.value } : null;
      const enabled = config ? config.enabled !== false : false;
      const debug = config ? config.debug === true : false;
      const maxCandidates = config ? clampInt(config.maxCandidates, 1, 3, 3) : 3;

      const [generation, setGeneration] = React.useState(0);
      const [result, setResult] = React.useState(null);
      const [hidden, setHidden] = React.useState(false);
      const [menuOpen, setMenuOpen] = React.useState(false);
      const previous = React.useRef({ id: sessionId, running: session?.running === true });
      const turnEndedAt = React.useRef(0);

      const draft = typeof input?.draft === "string" ? input.draft : "";
      const running = session?.running === true;
      const pending = session?.pendingInteraction !== undefined && session?.pendingInteraction !== null;
      const blank = session?.blank === true;

      React.useEffect(() => {
        const seat = document.querySelector("[data-composer-seat]");
        if (!seat) return undefined;
        let scheduled = false;
        const check = () => {
          const open = !!seat.querySelector(
            '[role="listbox"], [data-dsh-command-menu], [aria-haspopup="listbox"][aria-expanded="true"]',
          );
          setMenuOpen(open);
        };
        const schedule = () => {
          if (scheduled) return;
          scheduled = true;
          window.requestAnimationFrame(() => {
            scheduled = false;
            check();
          });
        };
        check();
        const observer = new MutationObserver(schedule);
        observer.observe(seat, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-expanded", "data-state", "hidden"],
        });
        return () => observer.disconnect();
      }, [sessionId]);

      React.useEffect(() => {
        const prev = previous.current;
        const currentRunning = running;
        if (prev.id !== sessionId) {
          previous.current = { id: sessionId, running: currentRunning };
          setResult(null);
          setHidden(false);
          return;
        }
        if (prev.running && !currentRunning && !pending && !blank) {
          turnEndedAt.current = Date.now();
          setHidden(false);
          setGeneration((value) => value + 1);
        }
        previous.current = { id: sessionId, running: currentRunning };
      }, [sessionId, running, pending, blank]);

      React.useEffect(() => {
        if (draft !== "" || running || pending || menuOpen) setHidden(true);
      }, [draft, running, pending, menuOpen, sessionId]);

      React.useEffect(() => {
        if (!enabled || generation === 0 || hidden || menuOpen || !sessionId) return undefined;
        if (draft !== "" || draft.startsWith("/") || running || pending) return undefined;
        const remaining = STRIP_TIMEOUT_MS - (Date.now() - turnEndedAt.current);
        if (remaining <= 0) return undefined;

        const controller = new AbortController();
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          try {
            controller.abort();
          } catch {
            /* already aborted */
          }
          setResult(null);
        }, remaining);

        Promise.resolve()
          .then(() =>
            predict(
              { sessionId, dismissed: dismissedFor(sessionId) },
              controller.signal,
            ),
          )
          .then((data) => {
            if (settled || controller.signal.aborted) return;
            const candidates = Array.isArray(data?.candidates)
              ? data.candidates
                  .map((item) => typeof item === "string" ? item : item?.text)
                  .filter((text) => typeof text === "string" && text.trim() !== "")
                  .map((text) => ({ text: text.trim() }))
                  .filter((item) => !isDismissed(sessionId, item.text))
              : [];
            if (candidates.length === 0) return;
            setResult({
              sessionId,
              generation,
              candidates: candidates.slice(0, maxCandidates),
              meta: data.meta && typeof data.meta === "object" ? data.meta : null,
            });
          })
          .catch(() => {
            /* silent by design */
          })
          .finally(() => {
            clearTimeout(timer);
          });

        return () => {
          settled = true;
          clearTimeout(timer);
          try {
            controller.abort();
          } catch {
            /* already aborted */
          }
        };
      }, [enabled, generation, hidden, menuOpen, sessionId, draft, running, pending, maxCandidates, predict]);

      const visible =
        !hidden &&
        !menuOpen &&
        result !== null &&
        result.sessionId === sessionId &&
        result.generation === generation &&
        draft === "" &&
        !draft.startsWith("/") &&
        !running &&
        !pending;

      React.useEffect(() => {
        if (!visible) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          const card = document.querySelector("[data-composer-card]");
          const active = document.activeElement;
          const inComposer = card && active && card.contains(active);
          const inStrip = active && active.closest && active.closest(".dns-strip");
          if (!inComposer && !inStrip) return;
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
          setHidden(true);
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
      }, [visible]);

      if (!visible) return null;
      const candidates = result.candidates.filter((item) => !isDismissed(sessionId, item.text));
      if (candidates.length === 0) return null;

      const choose = (text) => {
        try {
          inputActions?.setDraft?.(text);
        } catch {
          return;
        }
        setHidden(true);
        window.setTimeout(() => focus(sessionId), 0);
      };

      const dismiss = (text) => {
        rememberDismissed(sessionId, text);
        setResult((current) =>
          current === null
            ? current
            : { ...current, candidates: current.candidates.filter((item) => item.text !== text) },
        );
      };

      const tokens = result.meta
        ? (Number(result.meta.inputTokens) || 0) + (Number(result.meta.outputTokens) || 0)
        : 0;
      const seconds = result.meta ? (Number(result.meta.ms) || 0) / 1000 : 0;
      const metaText =
        debug && result.meta
          ? t("dock.debug", {
              tokens,
              seconds: seconds.toFixed(1),
              calls: Number(result.meta.calls) || 1,
            })
          : null;

      return h(
        "div",
        { className: "dns-strip", role: "group", "aria-label": t("dock.label") },
        [
          h("span", { className: "dns-lead", key: "lead", "aria-hidden": true }, t("dock.lead")),
          ...candidates.map((item) =>
            h("span", { className: "dns-chip", key: item.text }, [
              h(
                "button",
                {
                  type: "button",
                  key: "text",
                  className: "dns-chip-text",
                  title: item.text,
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => choose(item.text),
                },
                item.text,
              ),
              h(
                "button",
                {
                  type: "button",
                  key: "x",
                  className: "dns-chip-x",
                  title: t("dock.dismiss"),
                  "aria-label": t("dock.dismiss"),
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: (event) => {
                    event.stopPropagation();
                    dismiss(item.text);
                  },
                },
                "×",
              ),
            ]),
          ),
          metaText ? h("span", { className: "dns-meta", key: "meta" }, metaText) : null,
        ],
      );
    }

    function NextSuggestionSettings(props) {
      const { t, form } = props;
      const snapshot = useFormSnapshot(form);
      const ready = snapshot.status === "ready" && snapshot.value !== undefined;
      const value = ready ? { ...DEFAULT_CONFIG, ...snapshot.value } : null;
      const [draft, setDraft] = React.useState(null);
      const [status, setStatus] = React.useState("idle");
      const [catalog, setCatalog] = React.useState({ providers: [] });
      const [slow, setSlow] = React.useState(false);

      React.useEffect(() => {
        if (value !== null && draft === null) setDraft({ ...value });
      }, [value, draft]);

      React.useEffect(() => {
        if (ready) return undefined;
        const timer = window.setTimeout(() => setSlow(true), 6000);
        return () => window.clearTimeout(timer);
      }, [ready]);

      React.useEffect(() => {
        const controller = new AbortController();
        requestModels(controller.signal)
          .then((data) => setCatalog(data))
          .catch(() => {});
        return () => controller.abort();
      }, []);

      if (!form || (slow && !ready)) {
        return h("div", { className: "dns-settings" }, [
          h("div", { className: "dns-loading", key: "loading" }, t("settings.unavailable")),
        ]);
      }
      if (!ready || draft === null) {
        return h("div", { className: "dns-settings" }, [
          h("div", { className: "dns-loading", key: "loading" }, t("settings.loading")),
          h("div", { className: "dns-note", key: "note" }, t("settings.noteData")),
        ]);
      }

      const update = (key, next) => setDraft((current) => ({ ...(current || value), [key]: next }));
      const providerModels = catalog.providers.find((provider) => provider.id === draft.provider)?.models || [];
      const changed = Object.keys(DEFAULT_CONFIG).filter((key) => {
        const left = draft[key];
        const right = value[key];
        return typeof left === "number" ? Number(left) !== Number(right) : String(left ?? "") !== String(right ?? "");
      });
      const dirty = changed.length > 0;
      const busy = status === "saving";

      const save = async () => {
        if (busy) return;
        setStatus("saving");
        const ops = changed.map((key) => {
          const next = draft[key];
          if ((key === "provider" || key === "model") && String(next || "").trim() === "") {
            return { op: "unset", path: [key] };
          }
          return { op: "set", path: [key], value: key === "maxCandidates" || key === "timeoutMs" ? Number(next) : next };
        });
        let ok = true;
        try {
          ok = await form.mutate(ops, snapshot.revision);
        } catch {
          ok = false;
        }
        setStatus(ok ? "saved" : "error");
        if (!ok) window.setTimeout(() => setStatus("idle"), 2000);
        else window.setTimeout(() => setStatus("idle"), 1200);
      };

      const reset = async () => {
        if (busy) return;
        setStatus("saving");
        let ok = true;
        try {
          ok = await form.mutate(
            Object.keys(DEFAULT_CONFIG).map((key) => ({ op: "unset", path: [key] })),
            snapshot.revision,
          );
        } catch {
          ok = false;
        }
        setStatus(ok ? "saved" : "error");
        if (ok) setDraft({ ...DEFAULT_CONFIG });
        else window.setTimeout(() => setStatus("idle"), 2000);
      };

      const row = (key, labelKey, hintKey, control) =>
        h("div", { className: "dns-row", key }, [
          h("div", { className: "dns-row-text", key: "text" }, [
            h("div", { className: "dns-row-label", key: "label" }, t(labelKey)),
            h("div", { className: "dns-row-hint", key: "hint" }, t(hintKey)),
          ]),
          h("div", { className: "dns-row-control", key: "control" }, control),
        ]);

      return h("div", { className: "dns-settings" }, [
        h("div", { className: "dns-settings-head", key: "head" }, [
          h("div", { className: "dns-settings-title", key: "title" }, t("settings.title")),
          h("div", { className: "dns-settings-desc", key: "desc" }, t("settings.description")),
        ]),
        row(
          "enabled",
          "settings.enabled",
          "settings.enabledHint",
          h("input", {
            type: "checkbox",
            className: "dns-switch",
            checked: draft.enabled !== false,
            disabled: busy,
            onChange: (event) => update("enabled", event.target.checked),
          }),
        ),
        row(
          "maxCandidates",
          "settings.count",
          "settings.countHint",
          h(
            "select",
            {
              className: "dns-select",
              value: String(draft.maxCandidates || 3),
              disabled: busy,
              onChange: (event) => update("maxCandidates", Number(event.target.value)),
            },
            [1, 2, 3].map((count) => h("option", { value: String(count), key: count }, String(count))),
          ),
        ),
        row(
          "provider",
          "settings.provider",
          "settings.providerHint",
          h("input", {
            type: "text",
            className: "dns-input",
            value: draft.provider || "",
            placeholder: t("settings.providerHint"),
            disabled: busy,
            list: "dns-provider-list",
            onChange: (event) => update("provider", event.target.value),
          }),
        ),
        row(
          "model",
          "settings.model",
          "settings.modelHint",
          h("input", {
            type: "text",
            className: "dns-input",
            value: draft.model || "",
            placeholder: providerModels[0]?.id || t("settings.modelHint"),
            disabled: busy,
            list: "dns-model-list",
            onChange: (event) => update("model", event.target.value),
          }),
        ),
        row(
          "timeoutMs",
          "settings.timeout",
          "settings.timeoutHint",
          h("input", {
            type: "number",
            className: "dns-input dns-input-small",
            min: 1000,
            max: 15000,
            step: 100,
            value: String(draft.timeoutMs || 8000),
            disabled: busy,
            onChange: (event) => update("timeoutMs", Number(event.target.value)),
          }),
        ),
        row(
          "debug",
          "settings.debug",
          "settings.debugHint",
          h("input", {
            type: "checkbox",
            className: "dns-switch",
            checked: draft.debug === true,
            disabled: busy,
            onChange: (event) => update("debug", event.target.checked),
          }),
        ),
        h("datalist", { id: "dns-provider-list", key: "providers" }, catalog.providers.map((provider) =>
          h("option", { value: provider.id, key: provider.id }, provider.name || provider.id),
        )),
        h("datalist", { id: "dns-model-list", key: "models" }, providerModels.map((model) =>
          h("option", { value: model.id, key: model.id }, model.name || model.id),
        )),
        h("div", { className: "dns-actions", key: "actions" }, [
          h(
            "button",
            {
              type: "button",
              className: "dns-button dns-button-primary",
              disabled: busy || !dirty,
              onClick: save,
              key: "save",
            },
            busy ? t("settings.saving") : t("settings.save"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dns-button",
              disabled: busy,
              onClick: reset,
              key: "reset",
            },
            t("settings.reset"),
          ),
          h(
            "span",
            { className: "dns-status", key: "status", role: "status" },
            status === "saved" ? t("settings.saved") : status === "error" ? t("settings.error") : "",
          ),
        ]),
        h("div", { className: "dns-note", key: "note-cheap" }, t("settings.noteCheap")),
        h("div", { className: "dns-note", key: "note-data" }, t("settings.noteData")),
      ]);
    }

    /** Required client services: slots, locale, settings forms, conversation focus. */
    const inject = ["slots", "sessions", "locale", "configForms", "conversation"];

    function apply(ctx) {
      ensureStyle();
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, DICT), "next-suggestion: dictionaries");

      let form = null;
      try {
        form = ctx.configForms.get("next-suggestion");
      } catch {
        form = null;
      }

      const focus = (sessionId) => focusComposer(ctx, sessionId);
      const predict = (body, signal) => requestPrediction(body, signal);

      // Static dependencies ride the component closure; slot props still win so
      // tests and embedded occurrences can supply their own form or transport.
      const Dock = (props) =>
        h(NextSuggestionDock, { form, requestPrediction: predict, focusComposer: focus, ...props });
      const Settings = (props) => h(NextSuggestionSettings, { form, ...props });

      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register(
          {
            name: "conversation.input.dock",
            id: "next-suggestion",
            order: 15,
            locale: NS,
          },
          Dock,
        ),
      );

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "next-suggestion",
            order: 100,
            locale: NS,
            label: () => t("settings.nav"),
          },
          Settings,
        ),
      );

      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          {
            name: "plugins.bundle.config",
            key: "dsh-next-suggestion",
            locale: NS,
          },
          Settings,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
