---
name: research-workflow
description: Collect real research-paper PDFs from the web, extract file-backed evidence, feed that evidence into the existing adversarial conversation, and apply its main-agent conclusion. Use for literature-backed research or implementation, including requests to collect papers, inspect stored PDFs, debate findings, or ground code changes in cited evidence.
---

# Research workflow

Keep capabilities independent. Run only the stages requested by the user.

## Artifact contract

Use the visible project directory `research/` as the current research workspace. Do not create hidden directories, run ids, or pointer files.

- `manifest.json`: objective and identity
- `sources.jsonl`: accepted sources, direct PDF URLs, APA references, and file-backed evidence identities
- `papers/`: only downloaded PDFs that directly help answer the Research Question
- `evidence/`: one task-specific evidence file per accepted PDF
- `selection-report.md`: accepted, rejected, and failed candidate decisions
- `report.md`: the current Research Question answered from accepted downloaded documents
- `discussions/`: optional research-specific discussion artifacts

Treat the visible paths as the contract between stages. Do not rely on hidden in-memory state.

## Collect

1. Create a workspace with `research_workspace_create` unless the slash command already created it.
2. Search through the configured web MCP server. Prefer publishers, arXiv, conference sites, institutional repositories, and author pages over aggregators.
3. Treat search results only as candidate discovery. Search snippets, titles, abstracts, citation counts, and keyword overlap cannot establish relevance or support the report.
4. Send plausible direct HTTPS PDF URLs to `research_candidates_review` in batches.
5. The tool downloads candidates into a temporary directory, reads the downloaded PDFs, and evaluates direct answerability. The first criterion is whether the document contains evidence that materially answers the Research Question.
6. The tool rejects merely topical documents and moves only accepted PDFs into `research/papers/`. It writes accepted evidence to `research/evidence/` and every decision to `research/selection-report.md`.
7. The requested count is the accepted-paper target, not the number of web results. Search additional candidates when reviewed documents are rejected.
8. After reaching the target, or genuinely exhausting credible candidates, call `research_report_write` exactly once.
9. Report generation reads only the accepted local PDF evidence. It performs three model passes: a detailed draft, a structure-only rewrite, then a reordered final rewrite.
10. `research/report.md` answers the Research Question in its first substantive section, uses numbered citations such as `[1]` and `[2-5]`, and ends with deterministic APA-style entries such as `[1] Author. (Year). Document title. ...`.

During `/collect_papers`, use only the MCP gateway, `research_candidates_review`, and `research_report_write`. Never invoke Bash, Python, curl, requests, an ad hoc parser, `research_pdf_download`, or `research_sources_record`. If the web MCP tool is unavailable, stop and report that failure.

## Extract evidence

1. `/extract_papers` enumerates `research/papers/` systemically; the main model does not choose files or issue PDF tool calls.
2. Before PDF work, the main model performs exactly one IntentionThinking pass over the current conversation and extraction request. The resulting brief is shared by every paper; it is not repeated per PDF.
3. The extension calls `pdf_info` and `pdf_read_pages(ocr=false)` directly, detects damaged pages, and calls `pdf_render_pages` only for those pages.
4. The configured `subagentDefaultModel` receives the complete native extraction plus only the necessary page renders and performs the substantive paper reading and evidence extraction.
5. The `backgroundAgentDefaultModel` receives only live `SUBAGENT_FOCUS` events from the SubAgent and rewrites them into short user-visible progress text. It never produces or changes evidence.
6. Independent papers all run asynchronously and write one result each under `research/evidence/`; there is no fixed paper-concurrency or progress-event limit.
7. The main model is called after extraction to compare the task-specific evidence and report exact failures.
8. Keep claims, quotations, page references, limitations, and implementation implications attributable to the source PDF.

`research_pdf` remains available as a modular single-PDF operation. Its `task` must be the user's actual evidence question.

## Discuss and apply

Use the existing `/adversarial_discussion` command. Put `research/evidence/` and the exact decision to debate in its goal. After it ends, let its existing main-agent handoff record the conclusion and apply it to code or continue research. Do not duplicate the discussion command or handoff.

## Stage boundaries

- `/collect_papers` asks for the Research Question and accepted-paper target, then screens candidates and writes the grounded report.
- `/extract_papers` asks what to extract and uses the accepted PDFs in `research/papers/`.
- `/research_status` reports artifacts from `research/`.
- `/adversarial_discussion` performs the existing discussion and handoff.

If the user requests an end-to-end run, execute collect and extract, then ask them to start the existing `/adversarial_discussion` with `research/evidence/`. Never silently begin a paid multi-agent discussion from a collection-only command.
