---
name: pdf-to-latex
description: Recover only damaged PDF fragments after the research extension's deterministic pdf-mcp extraction. Use when attached page renders are needed to restore equations, tables, diagrams, or symbols missing from native text.
---

# PDF to LaTeX recovery

The research extension, not the model, controls PDF I/O. It calls `pdf_info`, reads every page with `pdf_read_pages(ocr=false)`, detects damaged native text, and renders only those pages. OCR is forbidden.

1. Treat the caller's task as the objective. Never replace it with a generic document summary.
2. Use the attached complete native extraction as the primary source.
3. Inspect an attached page image only when its matching native page is marked damaged.
4. Reconstruct equations, tables, columns, diagrams, and symbols only where native extraction failed.
5. Convert only visually reconstructed structured fragments to LaTeX. Keep intact prose as Markdown unless the caller explicitly requests full LaTeX.
6. Preserve document order and meaning. Never invent unreadable text; mark it as `\text{[illegible]}`.
7. Preserve all detail material to the caller's task and cite PDF page numbers for every finding.
8. When returning LaTeX, output valid LaTeX body content without a document preamble unless the caller asks for a standalone document.
