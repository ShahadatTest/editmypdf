# Contributing

Thanks for looking under the hood. Edit My PDF is a browser PDF editor that edits the text a page already
has, in the page's own font, with nothing sent to a server. This file explains how to run it, where
things live, and the one rule that matters more than any other.

## Running it

```bash
npm install
npm run dev
```

Vite serves the site and the editor on one port. `npm run build` type-checks and builds to `dist/`,
`npm run lint` runs oxlint, and `npx tsc --noEmit -p tsconfig.app.json` type-checks the app alone.

Put PDFs you test with in `public/samples/`; that folder is ignored by git. `public/sample.pdf` is
the one-page document behind the "Try a sample" button on the documents screen.

## Where things live

| Area | Files |
| --- | --- |
| Reading a page into editable elements | `src/content.ts`, `src/fontFix.ts`, `src/pageInk.ts` |
| Laying out and fitting text | `src/textLayout.ts` |
| Editing: patches, spans, the rich editor | `src/contentEdit.ts`, `src/SpanEditor.tsx`, `src/spanDom.ts` |
| The page stage, overlays and tools | `src/PageStage.tsx`, `src/App.tsx`, `src/ToolRail.tsx`, `src/ToolDock.tsx`, `src/Inspector.tsx` |
| Writing the PDF | `src/exportPdf.ts` |
| Storage in the browser | `src/session.ts` |
| The documents screen | `src/AppHome.tsx` |
| The marketing site | `src/site/`, with content in `src/data/` |
| Design tokens shared by both | `src/index.css` |

## The rule: nothing moves when you click

The editor's whole promise is that a text element opens looking exactly as the page prints it: the
same baseline, the same line ends, the same word gaps. We check this with real PDFs from different
producers and treat any visible shift on click as a bug. Before changing anything in `content.ts`,
`textLayout.ts`, `SpanEditor.tsx`, `contentEdit.ts`, `PageStage.tsx` or `exportPdf.ts`:

- Open several PDFs from `public/samples/` and click headings, single lines, paragraphs and table
  cells on a few pages. Nothing should jump.
- Type a character and undo it. The caret should land where you clicked.
- Download the result and open it again. The edited text should read back as text, in the same font,
  and every other item on the page should be where it was.

A few things that look like simplifications are not. `.page-frame` draws its edge with a `box-shadow`
rather than a border because a border shrank the canvas by two pixels against the overlays. The
baseline of the editor is measured on a hidden line box rather than computed from font metrics
because browsers round ascent and descent to whole pixels. The blog posts under `/blog` explain the
rest of the reasoning; they are written from this code and are a good map of it.

## Changing the site

Facts on the site come from the data files, not from the pages:

- `src/data/posts.ts` holds the blog posts as Markdown. After adding or retitling a post, run `node scripts/blog-cards.mjs`
  (Node 23.6 or later, and a Chromium binary; set `CHROME` to a path or command if none is found) to draw its link-preview card and its
  card picture into `public/blog/cards/`, and point the post's `image` and `thumbnail` at them.
- `src/data/competitors.ts` holds every comparison fact, with the date checked and the sources read.
  Update `checkedAt` and `sources` when you change a price or a limit.
- `src/data/faq.ts` and `src/data/product.ts` hold the FAQ and the product name, description and
  routes.

Please keep claims true. If a competitor is better at something, say so. If a vendor does not publish
a number, write "Not stated" rather than a guess.

## Pull requests

- Keep a pull request to one change, with a message that says what it does and why.
- Run `npm run build` and `npm run lint` before opening it.
- For editor changes, say which PDFs you checked and what you clicked.
- The repository has no automated tests yet. Adding fidelity checks that open a sample and compare
  the editor's lines against the PDF's text items would be a very welcome contribution.

## Licence

By contributing you agree that your contributions are licensed under the MIT licence in `LICENSE`.
