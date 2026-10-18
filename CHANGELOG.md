# Changelog

## 0.1.2

### A more considered next step · 让下一步，更贴合此刻。

- Build a compact state packet from tool names and targets, success/failure, changed file paths, job state, active goal/plan, and the assistant's open question.
- Generate up to five candidates, then rank at most three by concrete references, question fit, task state, and intent diversity.
- Match ASCII entities at token boundaries and exclude generic entity words from grounding signals.
- Add a replay exporter, fictional sample cases, and a local evaluator that reuses the shipped prompt, parser, and ranker. Similarity scores are diagnostic measures, not proof of live prediction accuracy.
- Strip assistant code fences from the open-question context as well as recent assistant prose.
- Require a completed run before applying the local ranking bonus for shipping changed files.
- Ignore private replay JSON exports by default while retaining only the fictional sample dataset.

本次更新加入紧凑任务状态与候选排序，使建议能够参考变更文件、执行状态和助手待答问题；同时补齐问题上下文中的代码清洗、提交建议排序条件与私人评测文件排除规则。

## 0.1.0

- First public release: optional next-instruction drafts, draft-only insertion, configurable provider/model routing, cancellation deadlines, and English/Chinese documentation.
