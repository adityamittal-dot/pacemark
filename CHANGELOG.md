# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-04

### Added
- PDFs now open as their original pages, with the highlighter moving over the real words on the page.
  A **PDF view** setting (and a link above the document) switches to plain text.
- Text size slider doubles as zoom for the page view; pages are redrawn sharply after zooming.

### Fixed
- Reading order follows the page layout: multi-column articles are read column by column, full-width
  titles and captions stay in place, even when the file stores its text out of order.
- Running headers, footers and page numbers are skipped instead of being mixed into the text.
- Words split into pieces inside the PDF (common with small caps and kerning) are joined back together.
- Footnote markers and tiny figure labels no longer interrupt sentences.

## [1.0.0] - 2026-10-03

### Added
- Web reader that opens PDF, Word (.docx), Markdown, HTML and plain-text files, or pasted text.
- Word-by-word highlight paced from 60 to 1000 words per minute, with optional longer pauses at punctuation.
- Five highlighter colors plus a custom color picker; marker, underline and outline styles; 1–3 words at a time.
- Smooth auto-scroll that glides the page as the highlight nears the bottom of the view.
- Keyboard controls, click-to-jump, sentence skipping and a seekable progress bar.
- Reading position remembered per file; settings remembered per device.
- Installable, fully offline app (PWA) with "Open with" file handling; also runs straight from a downloaded folder.
- Chrome extension that highlights any webpage in place, with a floating control bar, keyboard shortcut and context menus.
- Extension hand-off that opens PDFs (including Chrome's own PDF tabs) in the bundled reader.

[1.1.0]: https://github.com/adityamittal-dot/pacemark/releases/tag/v1.1.0
[1.0.0]: https://github.com/adityamittal-dot/pacemark/releases/tag/v1.0.0
