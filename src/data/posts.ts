// Blog posts, written from the editor's own source. Each body is Markdown with the extras in
// src/site/markdown.ts: ::: callouts, card grids and steps, :emoji: and {{icon}} shortcodes, and
// raw HTML for figures (classes in src/site/blog.css). Keep every technical claim checkable
// against src/.
import { iconHtml as icon } from "../site/blogIcons.ts";

// One of the site's palette hues (index.css); the card cover and the post page take it.
export type Hue = "accent" | "coral" | "teal" | "violet";

export type Post = {
  slug: string;
  title: string;
  description: string;
  // ISO date, used for ordering and display.
  date: string;
  tags: string[];
  // The post's hue, one of the palette hues, and the glyph PostCard.tsx sets large in the display
  // face (an operator, a symbol, a pair of letters) when a post has no thumbnail yet.
  cover: { glyph: string; hue: Hue };
  // Search phrases the post is written for, added to the tags in the keywords meta and JSON-LD.
  keywords?: string[];
  // The link-preview card (og:image), 1200×630, and the picture on the post's card, 1200×600:
  // the same scene, drawn for the post by scripts/blog-cards.mjs into public/blog/cards/.
  // Without an image the site card is used; without a thumbnail the glyph cover is drawn.
  image?: { src: string; alt: string; width: number; height: number };
  thumbnail?: string;
  body: string;
};

/* ---- Figure helpers --------------------------------------------------------- */

// A font's glyph table as a grid of cells, the glyphs in `used` lit.
function glyphGrid(glyphs: string, used: string, className = "bp-glyph-grid"): string {
  const cells = [...glyphs].map((glyph) => `<b${used.includes(glyph) ? ' class="bp-on"' : ""}>${glyph}</b>`).join("");
  return `<div class="${className}">${cells}</div>`;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,;:";
const USED = "Revnuwtpc";

// One tile of a flow diagram.
function tile(name: string, title: string, text: string, className = "bp-flow-tile"): string {
  return `<div class="${className}">${icon(name)}<span><b>${title}</b>${text}</span></div>`;
}

/* ---- The posts ---------------------------------------------------------------- */

const WHY_HARD = `
Ask a PDF where its paragraphs are and it has no answer. A page is a list of drawing instructions, and some of those instructions place glyphs. That's everything a PDF knows about text, and it's why "edit the text in a PDF" is a much harder promise than "put a text box on top of a PDF".

This post is about the specific places where that promise broke while I was building Edit My PDF. Every one of them is a case where clicking a line would make it visibly shift, and a shift on click is the thing I treat as a bug above all others.

A quick word on words. A glyph is a drawn shape: the particular curves of an "a" in one particular font. A PDF places glyphs, one by one, at coordinates. It doesn't store the word "apple"; it stores five shapes and where each one goes. Most of what follows comes from that.

## There are no words, only placed glyphs

Here's what a line of text looks like inside a page's content stream:

\`\`\`
BT
/F1 10.5 Tf
72 700 Td
[(Full-year) -278 (re) 15 (v) 10 (enue) -278 (gre) 20 (w)] TJ
ET
\`\`\`

\`BT\` and \`ET\` open and close a text object, \`/F1 10.5 Tf\` picks font F1 at 10.5 points, and \`72 700 Td\` moves the cursor to 72 points from the left and 700 from the bottom. The \`TJ\` operator shows the strings in the brackets and, between them, numbers that nudge the cursor left or right in thousandths of the font size. "revenue" arrives as three strings with two tiny nudges between them, and the \`-278\` entries are the spaces, drawn as gaps rather than as a space character. A word can be one string or five. A justified paragraph is often set with no spaces at all, every word positioned on its own.

So the editor never trusts the strings alone. It walks the operator list that pdf.js produces when it renders the page and builds what I've been calling a glyph stream: every glyph the page drew, in order, with the font, size, character spacing and word spacing in force at the moment it was drawn. The text items pdf.js reports are then matched against that stream, so each one knows how it was really set.

## The fonts aren't the fonts you think

A PDF embeds its fonts, usually as subsets with only the glyphs the document used, often with a private encoding. The browser can't use those directly, so pdf.js converts each one to OpenType and registers it as a font face.

In pdfjs-dist 6 those converted fonts put every glyph at a private-use code point. Unicode entries are added only as a courtesy, and they aren't always right: a ligature glyph can end up in a plain letter's slot. Rendering doesn't care, because pdf.js draws by glyph code. Typing cares a lot, because when you type an "f" the browser looks the character up in the font's Unicode table (its cmap, which is more or less the font's phone book) and may hand back the "fi" ligature, because that's where the book pointed.

The editor fixes this by building a corrected copy of each face. It collects, from the page's own showText operations, which glyph the page used for each Unicode character, rewrites the cmap so every character maps to that glyph, and registers the copy under its own family name. Only characters whose Unicode entry pointed somewhere else need fixing, so pages that agree with the font share one registered face.

## The space that isn't there

The converted fonts have no space glyph. When the browser lays out "grew nine per cent" in such a face it draws the letters from the embedded font and the spaces from the fallback family. A fallback space is about 250 units wide; the spaces in the documents I tested were 318 to 348. Every line with spaces came out several points narrower than it printed, and the whole paragraph looked a little off the moment you clicked it. This one quirk was behind most of the "the styling changes when I click" reports I got early on.

<figure>
<div class="specimen-row"><span class="specimen-label">The page</span><span class="specimen-line page">Revenue grew nine per cent to $4.2 billion<span class="ruler"></span></span></div>
<div class="specimen-row"><span class="specimen-label">Fallback space</span><span class="specimen-line fallback">Revenue grew nine per cent to $4.2 billion</span></div>
<div class="specimen-row"><span class="specimen-label">Fitted</span><span class="specimen-line fitted">Revenue grew nine per cent to $4.2 billion</span></div>
<figcaption>The same line set three ways. With the fallback font's narrow space the line ends early; after fitting, its spaces take exactly the width the page gave them.</figcaption>
</figure>

The fix is to stop trusting the font for spaces. For each text item the editor measures the letters alone in the page's face, compares that with the width the page actually drew, and spreads the difference over the spaces as CSS word spacing. Letter spacing takes the stream's Tc plus any mismatch between the page's glyph advances and the face's own, spread over the letters. A run with no spaces puts the whole residual between its letters, which is also where a dot leader and its page number leave it.

## Spacing is state, and state leaks

Tc and Tw are part of the graphics state. \`q\` saves it and \`Q\` restores it. A document that sets a wide Tc inside one q … Q block and then draws a normal paragraph after the Q is perfectly valid, and a reader that forgets to pop the state will track the whole paragraph.

I know because one of my test documents opened with a paragraph spaced out like a ransom note. Its heading had been tracked inside a q … Q pair, and my reader was still carrying the heading's character spacing when the body text came along. One missing restore.

Two more spacing traps turned up in real files. Tracked small caps reach pdf.js as a space after nearly every letter, because the wide Tc looks like a gap; the glyph stream knows which spaces the page really drew, so the tracking is turned back into letter spacing and the fake spaces go away. And two-byte spaces in Identity-H fonts get word spacing added by pdf.js's text extraction but not by its renderer, so the reported positions drift right by Tw for every such space before the item and have to be pulled back by the count of those spaces in the glyph stream. The NMDC press release in my test set has exactly this.

## One paragraph, several faces, no reliable colours

A paragraph that starts with a bold lead-in is one paragraph to a reader and two fonts to a PDF. Worse, a font with bold baked into its outlines reports weight 400 to pdf.js, so bold can't be told from a heading face by weight alone. Colour is even less reliable: the colours in the operator list don't line up one-to-one with the text items pdf.js reports. The editor reads each run's colour from the rendered page instead, averaging the darkest ink pixels under the run's box.

Mixed-face paragraphs ended up needing their own editor; that story is in [Editing a paragraph that mixes faces as one block](/blog/mixed-face-paragraphs).

## Pages aren't set on a grid, and browsers round

Lines in a block are rarely pitched evenly. A Wikipedia print alternates 15.75 and 15.0 point line spacing. A list item's bullet is drawn in a smaller font whose box sorts after the item's first line. So a block records an offset for every line against an even pitch, and an indent for every line against the block's left edge.

Then the browser has its own opinion. Chrome rounds a font's ascent and descent to whole pixels when it builds a line box, so a baseline computed from the font's metrics lands a pixel off at some zoom levels. Get the baseline (the invisible line the letters sit on) one pixel wrong and the whole line looks like it twitched when you clicked, even though every letter is the right shape and size. The editor measures the baseline instead, on a hidden line set exactly like the editor's, and caches the result once the face has finished loading.

## What this adds up to

None of these problems is exotic. They're what ordinary PDFs look like: a LaTeX paper, a Word export, a press release, a printed web page. Editing one in place means reconstructing a reading of the page that's exact to a fraction of a point, and then handing that reconstruction to a browser text editor without it changing anything.

The next post goes through that reconstruction measurement by measurement: [Opening an element exactly as the page prints it](/blog/exactly-as-the-page-prints-it).
`;

const EXACT = `
The rule I hold the editor to is simple to say: when you click a piece of text, nothing moves. Not the baseline, the line ends or the word gaps. The text under the cursor should look like the page until the moment you type.

It's a strict rule, and I check it with a probe that opens each of eleven test PDFs, clicks every text element on every page and measures the editor's lines against the PDF's own text items, with a tolerance of a few hundredths of a point. This post is what it takes to pass that.

The reason it's hard: a PDF is a finished drawing, and a browser text editor is a live layout engine with its own fonts, its own rounding and its own ideas about spaces. Making the second look exactly like the first means measuring the drawing in several places and feeding the browser numbers it would never have chosen by itself.

## Reading the page twice

Everything starts from two things pdf.js can give for a page: its text items, with a transform and a width for each, and its operator list, the drawing instructions that produced the rendered canvas. The editor walks the operator list to build a glyph stream, every glyph the page drew, in order, with the Tc, Tw and font size in force when it was drawn. Then it pairs that stream with the text items, so each item knows the state it was drawn in and the summed advance of the glyphs matched to its letters.

<figure>
<div class="bp-dg bp-flow" aria-hidden="true">
${tile("file-text", "Text items", "a string, a transform and a width, from pdf.js")}
<span class="bp-flow-arrow">+</span>
${tile("binary", "Operator list", "every glyph drawn, with Tc, Tw and font size")}
<span class="bp-flow-arrow">→</span>
${tile("scan-text", "Glyph stream", "each item paired with the state it was drawn in")}
</div>
<figcaption>Two readings of the same page, joined. Without the pairing, a text item is only a string and a width.</figcaption>
</figure>

## Fitting each run

For every run, a function called runSpacing answers one question: what letter spacing and word spacing make the browser set this string, in this face, exactly as wide as the page drew it?

Letter spacing starts as the stream's Tc, scaled from the operator's font size to the item's. If the page's glyph advances differ from the converted face's own (a substituted font, or one whose advances pdf.js adjusted), the mismatch is spread over the letters too, clamped to a few hundredths of an em. Word spacing takes whatever is left once the letters are measured, spread over the spaces and clamped to what a space can reasonably absorb. A run with no spaces spreads the whole residual between its letters. And the trailing gap is trimmed: CSS letter spacing also trails the last glyph, while the page's width stops at its ink, so one letter-spacing is subtracted before the residual is computed.

That last detail is a fair sample of what most of this work is like.

## Fitting each line

Runs are grouped into lines by baseline, and a line is then fitted as a whole: its runs are measured in their faces with their letter spacing, and the difference from the line's drawn width lands on its spaces as one word-spacing value for the line. A justified paragraph's lines each get their own value, which is how a justified block opens with every line exactly as long as it prints without the editor having to justify anything. A line with no spaces, say a table of contents entry whose dot leader runs into its page number, spreads the difference over its letter gaps instead.

## Keeping a block's layout

A multi-line block is more than its lines. blockFace picks the longest line's font as the block's face, the first line's baseline, the median baseline pitch as the line height, and infers the alignment from where the lines start and end. Then blockContent joins the lines into one editable text while recording four things per line.

Its offset from an even pitch, so a block whose lines alternate 15.75 and 15.0 points opens with every baseline where the page put it. Its indent from the block's left edge, for a first-line indent, a hanging indent or a ragged left margin. Its word gap, the fitted word spacing from the previous step. And whether its line break is hard or soft. A break the author chose (a centred or right-aligned block, a line that ends although the next word would still have fit, a hyphenated word) is a real newline. A break that only exists because the column ran out of room is soft: it's kept until you edit, and then it becomes a space so the text can flow again.

## Putting the editor on the baseline

The editor is a block of text laid out by the browser. For its first baseline to land on the PDF baseline, I need the distance from the top of a CSS line box to the alphabetic baseline for this face at this line height. The browser rounds a font's ascent and descent to whole pixels when it builds a line box, so computing that distance from the font's metrics is wrong by up to a pixel at some zoom levels, and wrong in a way that changes as you zoom.

So the distance is measured. A hidden line containing "Hg" and a zero-size marker is set with the editor's exact font and line height, the marker's position is read, and the result is cached per face and line height once document.fonts.check says the face has finished loading. A face still loading measures with its fallback, and that measurement is thrown away. This pattern comes up again and again in the editor: when the browser is the one doing the rounding, ask the browser what it did rather than predicting it.

## Reading the pixels

Some things the content stream doesn't say plainly, and the rendered page does. Colour: the colour of a run is read from the canvas under its box, as the average of the darkest fifteen per cent of ink pixels, because operator-list colours don't line up with text items reliably enough to use. Backdrop: when you click, the background colour under the run is sampled from the edges of its box, so the edit's backdrop matches a tinted table cell as well as white paper. Underline: a single-line underline is found in the lower part of the run's box and reproduced, in its own colour, under the edited text. Tails: runs on the same baseline immediately to the right of the clicked one are snapshotted, so when the edited text gets longer or shorter they move with it.

## The pixel I lost to a border

For a few weeks every edit sat two pixels off in the editor and nowhere else, and I couldn't see why. The page frame had a one-pixel CSS border. A border shrinks the canvas inside the frame by two pixels while the overlays above it keep the page's full size, so the rendered page and the editor disagreed by exactly that much. The frame now draws its edge with a box-shadow ring outside the box, and there's a comment in the stylesheet explaining why, so nobody (me, mostly) puts the border back.

<figure>
<div class="bp-dg" aria-hidden="true">
<div class="bp-pg"><div class="bp-frame bp-bordered"><div class="bp-canvas"></div><div class="bp-overlay"></div></div><span class="bp-dg-label">A border: the canvas shrinks, the overlays (dashed) do not</span></div>
<div class="bp-pg"><div class="bp-frame bp-ring"><div class="bp-canvas"></div><div class="bp-overlay"></div></div><span class="bp-dg-label">A ring outside the box: canvas and overlays agree</span></div>
</div>
</figure>

## What exact buys you

When all of this holds, clicking a line is undramatic. The text doesn't jump, the gaps don't change, and the caret appears where you clicked. Then you type, and from that point on the paragraph flows like any other text, inside its own column, in the page's own font. Everything above exists so that nothing visible happens.
`;

const EXPORT = `
Until recently, downloading an edited PDF from Edit My PDF gave you a page where every edit was a picture. The edited text was painted at three times resolution into a PNG and placed over a white patch that hid the original words. It looked right at a glance. It was also unsearchable and unselectable, blurry at high zoom, and it left the original words in the file under the patch, where a search or a copy would still find them.

<figure>
<div class="bp-dg" aria-hidden="true">
<div class="bp-pg"><div class="bp-mini-page"><i class="bp-ln bp-w6 bp-head"></i><i class="bp-ln bp-w9"></i><i class="bp-ln bp-w8"></i><span class="bp-patch" data-label="png"><i class="bp-ln bp-w7 bp-edit"></i><i class="bp-ln bp-w7 bp-ghost"></i></span><i class="bp-ln bp-w9"></i><i class="bp-ln bp-w5"></i></div><span class="bp-dg-label">Before: a picture over a white patch, the old words still underneath</span></div>
<span class="bp-dg-arrow">→</span>
<div class="bp-pg"><div class="bp-mini-page"><i class="bp-ln bp-w6 bp-head"></i><i class="bp-ln bp-w9"></i><i class="bp-ln bp-w8"></i><i class="bp-ln bp-w7 bp-edit"></i><i class="bp-ln bp-w9"></i><i class="bp-ln bp-w5"></i></div><span class="bp-dg-label">After: real text in the page's own font, the old words gone</span></div>
<div class="bp-dg-legend"><span style="--sw: var(--tone)">your edit</span><span style="--sw: #a8a59c">original words, hidden but still in the file</span></div>
</div>
<figcaption>What the download used to contain, and what it contains now.</figcaption>
</figure>

Edits are now written as text, in the page's own font, with the original strings removed. This post goes through the three steps that get there, and the few cases where a picture is still the honest answer.

If PDF internals are new to you: every page is a little program, a list of drawing instructions such as "use font F1 at 10.5 points", "move here", "show these characters". That list is the page's content stream. It has no idea what a word, a line or a paragraph is. It only knows where it put each glyph, which is why taking a sentence out of it takes some care.

## Step one: take the original words out of the page

You can't edit a content stream by searching for a word, because the word may be five strings, and because moving one string moves everything drawn after it in the same text object. The editor's content-stream reader lexes the stream into operators with the byte range each one occupies, and tracks the text state as it goes: q/Q, cm, BT/ET, Tf, Tc, Tw, Tz, TL, Ts, Td, TD, T* and Tm. At every string shown by Tj, TJ, ' or " it knows where the first glyph will land on the page.

A string whose first glyph starts inside an edited element's box (with a margin of a point and a half) counts as the element's text. It's replaced by a number inside a TJ array equal to the string's advance, computed from the page's font resources: /Widths and /MissingWidth for simple fonts, /W and /DW for CID fonts, scaled by the font matrix for Type 3. The cursor ends up exactly where the string would have left it, so the text that follows in the same object stays put. A TJ that spans a whole table row loses only the strings inside the box.

<figure>
<pre class="bp-stream" aria-hidden="true"><code><span class="bp-c">before: one TJ draws the whole line</span>
BT /F1 10.5 Tf 72 700 Td
[(Revenue) -278 (grew) -278 (nine) -278 (per) -278 (cent)] TJ
ET
<span class="bp-c">after the strip: "Revenue grew" was edited, the rest was not</span>
BT /F1 10.5 Tf 72 700 Td
[<del>(Revenue)</del><ins>-3890</ins> -278 <del>(grew)</del><ins>-2210</ins> -278 (nine) -278 (per) -278 (cent)] TJ
ET</code></pre>
<figcaption>Each string inside the edited box becomes a number worth exactly its advance (the values here are illustrative). "nine per cent", which you did not touch, lands where it always did.</figcaption>
</figure>

Why a number rather than just deleting the string? Inside a TJ array a negative number moves the cursor to the right by that many thousandths of the font size. Swapping a string for its own width leaves a gap the exact size of the missing word. Delete the string outright and every word after it slides left to fill the hole.

A few details. ' and " have side effects (a line feed, new word and character spacing) that are kept in front of the rewritten array. Inline images are skipped by their computed length, or by finding a free-standing EI when they're filtered. Streams are decoded with pdf-lib, joined, rewritten by splicing the byte ranges with everything else copied verbatim, and written back as one flate stream.

Text drawn by a form XObject, a reusable block of drawing that a page invokes with Do (letterheads, stamps), isn't descended into. A Do whose bounding box meets an edited element marks that edit as uncertain, and the white backdrop is kept for it.

## Step two: embed the font that pdf.js already decoded

The exported text has to be set in the same face as the page, and that face is a font pdf.js converted to OpenType when it rendered the page. The editor asks pdf.js to keep those bytes (\`fontExtraProperties\`) and embeds them with pdf-lib and fontkit, taking the cmap-corrected copy when the editor registered one.

<figure>
<div class="bp-dg" aria-hidden="true">
<div class="bp-pg">${glyphGrid(ALPHABET, USED)}<span class="bp-dg-label">The converted font: every glyph, about 800 KB</span></div>
<span class="bp-dg-arrow">→</span>
<div class="bp-pg">${glyphGrid(USED, USED, "bp-glyph-grid bp-small")}<span class="bp-dg-label">The subset: only the glyphs your edit uses</span></div>
</div>
<figcaption>Subsetting keeps the glyphs the edited words need and drops the rest of the table.</figcaption>
</figure>

Subsetting isn't optional. A converted font carries the original font's whole glyph table, around 800 kilobytes per face in my tests. With \`subset: true\` only the glyphs the edits use are written. A press release with a heading and a paragraph edited came out at 250 kilobytes against 232 for the original; without subsetting it would have gained about 350 kilobytes per face. If pdf-lib can't subset a particular font, the whole font is embedded rather than giving up.

## Step three: place each word where the editor showed it

The editor already knows where every word sits: the same layout function that draws the on-page editor returns each run's words with an absolute x position and a baseline. Export writes one text matrix and one TJ per run. The text matrix maps the editor's page coordinates onto the PDF page, including any page rotation. Tc is set to the run's letter spacing; Tz, Tw and Ts are reset so nothing inherited from the page leaks in.

<figure>
<div class="bp-dg bp-kern-line" aria-hidden="true"><span class="bp-kw">Revenue</span><span class="bp-kg">−278</span><span class="bp-kw">grew</span><span class="bp-kg">−305</span><span class="bp-kw">nine</span><span class="bp-kg">−291</span><span class="bp-kw">per</span><span class="bp-kg">−284</span><span class="bp-kw">cent</span></div>
<figcaption>No space characters: each gap is a kern that drops the next word exactly where the editor had it, so a justified line keeps its own gaps.</figcaption>
</figure>

Inside the TJ array, every word but the first is preceded by a kern that lands it exactly where the editor put it. No space glyph is written at all, because the converted fonts have none. A justified line therefore exports with the same word gaps the editor showed, computed rather than set. (Typographers use "kern" for the tightening between two particular letters. In a TJ array it's just a number that moves the cursor before the next string. I'm using those numbers as the spaces between words.)

## When it still paints a picture

Three cases fall back to the old PNG path, for that one edit only; everything else on the page is exported as text. First, when there are no outlines to embed: the face is a Type 3 font, whose glyphs are tiny drawing programs rather than outlines, or a font the PDF didn't embed and pdf.js matched to a system font, so there are no bytes to write the text in. Second, when pdf-lib can't parse the converted font. Rare, but it happens, and rather than fail the whole download that one edit is painted. Third, when you typed a character the subset has no glyph for, a "ß" into a font that never had one. The editor already shows such a character in a fallback face, so nothing is hidden from you.

The white backdrop under an edit is only drawn when it's needed: when the strip removed nothing or was uncertain, when a tail to the right of the edit had to move, or when the run has an underline that the removed text no longer provides.

## Checking the result

I load the exported file back into the editor like any other PDF and run the same fidelity probe that checks the editor against the original page. For the press release, pdf.js reads the edited words from the exported file, both edits open as editable text in the embedded face, and every other text item on both pages is at the position it had in the original. Every element in the re-opened export measured within two hundredths of a point of where the editor showed it, which was the number I was after.

## What's left

Two gaps, both narrow. Text inside form XObjects is covered rather than removed, as above. And fonts with no width information, such as one of the standard fourteen used without embedded metrics, have their strings removed without the compensating advance, so later text in the same text object could shift. Standard-font metrics would close that, and it's on my list.
`;

const MIXED = `
Most text on a page is set in one face. The exceptions are the interesting ones: a paragraph with a bold lead-in, a sentence with an italic title in it, a definition whose term is set in small caps. A reader sees one paragraph. A textarea can hold only one font. So a paragraph that mixes faces needed an editor of its own, and this post is about how that editor works.

## The model: spans, not runs

When the editor reads a page it collects text runs, the pieces pdf.js reports, each in one font. For a line, adjacent runs in one face are joined into a span; a gap wider than a sliver becomes a space; whitespace collapses the way the text would read. A span records its family, weight, style, size, colour, the PDF font it came from, and its own letter spacing when the page tracked it apart from its neighbours. It also keeps the page box its glyphs occupy, because the colour is read from the rendered pixels under that box.

<figure>
<p class="spans-demo"><span data-face="bold"><b>Revenue.</b></span> <span data-face="regular">Revenue grew nine per cent to $4.2 billion, with growth in</span> <span data-face="italic"><i>every</i></span> <span data-face="regular">region.</span></p>
<figcaption>One paragraph, four spans. Each span carries its face, size, colour and PDF font name; the text between them is one string with the spans laid over it.</figcaption>
</figure>

Then the lines of a block are joined, and neighbouring spans in the same face whose colours are as good as equal (within 20 on each channel) are merged, so a paragraph read line by line edits as a few runs rather than one per line. To keep the two words straight: a run is what pdf.js hands over, a fragment of text in one font, often one per line or less; a span is what the editor works with, the longest stretch of text that shares one look. Several runs make a span, and a few spans make a paragraph.

## Deciding what belongs together

Which lines flow into one paragraph? Two lines can continue each other when they share a dominant face, or when the next line's face already appears in the previous one. That second rule is what joins a bold lead-in to the regular text that follows it.

The reverse pairing is deliberately left apart: a single-face line above a mixed line that merely contains its face. That's what a heading followed by a paragraph with a bold lead-in looks like, and pdf.js can't tell a heading face from a bold one when the weight is baked into the font outlines. Getting this wrong would swallow headings into paragraphs, so the editor errs on the side of keeping a heading on its own.

## The editor owns its DOM

The mixed-face editor is a contentEditable block with one \`<div>\` per line and one \`<span>\` per styled run. React doesn't render its contents; the component does, from the model, and it intercepts every edit before the browser applies it.

contentEditable turns any part of a web page into something you can type into, and left to itself the browser edits the markup however it likes, which would wreck the spans. The beforeinput event fires just before each edit and says what the browser intends to do, which is the moment to step in. The affected character range is read from the event's target ranges, the change is applied to the spans in the model, the lines are drawn again, and the caret is put back.

Typed text takes the face of the character before the caret, so a new word typed after a bold run stays bold. Line breaks become a real newline in the model and a new line \`<div>\`. Deletes, backward or forward, remove the range from the spans; a span that loses all its text disappears, except the last one, which stays so typing can continue. Composed input (Japanese, Chinese, dead keys) can't be intercepted this way, so for those the editor lets the browser apply the change and then reconciles: it reads the DOM text back, finds the common prefix and suffix against the model, and applies the difference as one edit.

The editor also keeps its own undo history of two hundred steps and handles Cmd+Z and the browser's historyUndo input itself, so undo moves through spans rather than through whatever the browser's contentEditable undo would do to the DOM.

## Lines where the page put them

Because the component draws the lines, it can also place them. Each line \`<div>\` gets the page's indent for that line (as a text indent on the first line, as padding on the others), a top margin for its baseline offset from an even pitch, and the page's own word spacing for that line. A line the page gave a word gap is already exactly as wide as printed and is never stretched; only a line that flows again after an edit in a justified block is justified by the browser.

Caret positions are character offsets into the whole text. A small helper maps between those offsets and DOM selection points, with the one subtlety that the newline between two line \`<div>\`s has no node of its own.

## Letting the text flow

A paragraph opens with every line break of the page. Breaks that only exist because the column ran out of room are marked soft.

::: pair When it opens | After the first edit
- Every line break of the page is kept, soft or hard.
- Every line has the page's indent, baseline offset and word gap.
- Nothing is re-wrapped, so nothing moves.
---
- Soft breaks from the edit onward become spaces, so the text reflows inside the paragraph's width.
- Lines above the edit keep their printed breaks, gaps and positions.
- Offsets are preserved through the change, so the caret doesn't jump.
:::

## Export

Each span's face is embedded separately on export, and each word is placed in its own span's face at the position the editor showed. The same layout code serves the editor, the painted fallback and the real-text export. That isn't tidiness for its own sake; it's the only reason the three agree.
`;

const PRIVACY_POST = `
"Your files are safe with us" is a sentence a PDF service has to say because it has your files. Edit My PDF doesn't have them. This post is about the architecture that makes that true, what it costs, and how you can check it yourself.

## There is no server

Edit My PDF is a single-page app built with React and Vite. When you open it, your browser downloads the JavaScript, stylesheets, fonts and icons, and from then on everything happens in the tab.

<figure>
<div class="bp-dg bp-flow" aria-hidden="true">
${tile("file-text", "Your PDF", "opened from your disk")}
<span class="bp-flow-arrow">→</span>
${tile("cpu", "Your tab", "pdf.js reads it, you edit it, pdf-lib writes it")}
<span class="bp-flow-arrow">→</span>
${tile("download", "Your downloads", "the new file, saved by the browser")}
${tile("server-off", "No server", "nothing to upload to, nothing to leak from", "bp-flow-tile bp-off")}
</div>
<figcaption>The whole path of a document. Nothing on it leaves your machine.</figcaption>
</figure>

<dl class="kv">
<dt>Reading</dt><dd>pdf.js parses the PDF and renders pages to canvases inside a web worker bundled with the app.</dd>
<dt>Editing</dt><dd>Edits are a list of changes kept in memory next to the file: a text patch, a pencil stroke, a shape.</dd>
<dt>Saving</dt><dd>The file's bytes and the edit list are written to IndexedDB in your browser, so the document's link keeps working after a refresh.</dd>
<dt>Downloading</dt><dd>pdf-lib builds the new PDF in the tab; the browser saves it from a temporary blob URL.</dd>
</dl>

If "web worker" and "IndexedDB" are new words: a web worker is a background thread inside your tab, which is how rendering a page doesn't freeze the interface, and IndexedDB is a small database every browser keeps on your own disk, one per website. Both live on your computer. Neither is a service.

There's no upload endpoint because there's no backend. The repository has no server code at all. The app's own code calls \`fetch\` in three places, and each one loads a file of the site's own: the sample PDF on the documents screen, a supplement font when a page needs one, and an emoji image when you export an emoji.

## What the app does ask the network for

I'd rather give you the whole list than a reassuring summary. The app requests its own static files from wherever it's hosted, and since the [November 2026 release](/blog/scans-cjk-text-and-colour-profiles) that includes pdf.js's helper files, the image decoders, character maps and stand-in fonts, which it fetches from the same site the first time a document needs one. The host sees what any web server sees for those requests: your IP address, your browser's user agent and the page address. It never receives your document, your edits or the file's name, because the app doesn't send them. There's no analytics script on the editor pages, no error reporting service, no account system and no third-party embed.

## What this buys

No limits that exist to sell an upgrade: no file counter, no size cap, no watermark. The only limit is your browser's memory. No waiting on an upload, so a 50-megabyte scan opens as fast as your disk can read it. And documents that stay where you put them. Each PDF you open gets its own link in this browser, you can keep several open in tabs, and a refresh brings each one back with its edits.

## What it costs

No OCR and no conversion. Recognising text in a scan, or turning a PDF into a Word file, needs large models or engines that are better run on a server, and I'd rather not pretend otherwise; the [comparisons](/compare) say which tools do those jobs. One browser, one machine: your documents aren't synced anywhere, so the same link on another computer won't know the document. And memory. Everything is in RAM, so a very large file is limited by what the browser will hold.

## How to check for yourself

::: steps
- **Open the developer tools** in your browser and choose the Network tab.
- **Open a PDF** in Edit My PDF, edit a line and download the result.
- **Read the list.** You'll see requests for the app's own files and nothing else. No request carries your PDF.
:::

If you read code, the source is public. The reader is \`src/pdf.ts\`, the writer is \`src/exportPdf.ts\` and storage is \`src/session.ts\`. Search \`src\` for \`fetch\` and you'll find those three loaders and nothing that sends a document anywhere.

## What I can't promise

The browser is yours, and so is everything in it. A browser extension can read the pages you have open. Your downloads folder is as safe as your computer. And whoever hosts the app can see that you loaded it. Those are the limits of what a client-side app can promise, and I'd rather state them than pretend they aren't there.
`;

const LEAVES_ALONE = `
Knowing what an editor won't touch matters as much as knowing what it can do. Edit My PDF reads a page carefully, and part of reading carefully is deciding what to leave alone. This is the list of those decisions and the reason for each.

## Text the page painted over

A PDF can draw text and then paint a filled box or an image over it. Readers never see that text, but it's still in the file. An earlier version of the editor exported edits as pictures over a white backdrop, so a file that had been edited and re-opened carried its original words under each patch.

<figure>
<div class="bp-dg" aria-hidden="true">
<div class="bp-pg"><div class="bp-mini-page bp-wide"><i class="bp-ln bp-w6 bp-head"></i><i class="bp-ln bp-w9"></i><span class="bp-paint" data-label="painted later"><i class="bp-ln bp-w8 bp-ghost"></i><i class="bp-ln bp-w5 bp-ghost"></i></span><i class="bp-ln bp-w9"></i><i class="bp-ln bp-w7"></i></div><span class="bp-dg-label">Two lines under an opaque fill: in the file, invisible on the page, not offered for editing</span></div>
</div>
</figure>

The page reader now tracks every opaque fill and image with the order it was painted in. A text run that lies wholly under opaque paint applied after it isn't offered for editing. What you can click is what you can see.

## Tables

Rules, the thin filled rectangles that make up table borders, are collected from the operator list, merged where they touch, and joined into table boxes. A table is an element of its own: you can move it or resize it as a block. The text inside its cells stays reachable as text, so a figure in a cell can still be clicked and retyped, and the shapes that happen to sit inside a table aren't reported twice.

## Fonts without outlines to embed

Three kinds of text open in a fallback face rather than the page's own: a Type 3 font, whose glyphs are small drawing programs rather than outlines; a font the PDF didn't embed, which pdf.js renders with a matching system font; and a character you type that the embedded subset has no glyph for.

In all three cases the editor still fits the line to its printed width, so it opens looking right. On download, such an edit is painted as an image rather than written as text, because there's no face to write it in. Everything else on the page is unaffected. (Most fonts describe each letter as an outline that can be scaled and filled. A Type 3 font describes each letter as a tiny PDF drawing. It renders fine, but there's no outline to hand to the browser or to embed in an export.)

## Text inside form XObjects

A form XObject is a reusable block of drawing that a page invokes with Do. Letterheads, stamps and some page templates live there. The export removes the original strings under an edit from the page's own content stream, but it doesn't descend into forms. When a form's bounding box meets an edited element, that edit is marked uncertain and a backdrop is kept under it, so the result looks right even though the covered text is still in the file.

## Spaces the page never drew

Some text reaches pdf.js with spaces that aren't on the page. Tracked small caps arrive as a space after nearly every letter. Two-byte space codes in Identity-H fonts have word spacing added by the text extractor that the renderer never applied.

<figure>
<p class="bp-phantom" aria-hidden="true">S<i>␣</i>M<i>␣</i>A<i>␣</i>L<i>␣</i>L <i>␣</i>C<i>␣</i>A<i>␣</i>P<i>␣</i>S</p>
<figcaption>Tracked small caps as the text extractor reports them. The struck spaces were never drawn; the page only spread the letters.</figcaption>
</figure>

The glyph stream read from the operator list knows what was really drawn, so the fake spaces are removed and the drifted positions pulled back. The text you edit is the text the page shows.

## List markers and hyphens

Bullets are usually drawn in a smaller font, and a bullet's box sorts after the first line of its item, so the reader recognises a marker beside a line and keeps the two together. A hyphen at the end of a line marks a hard break, since breaking the line anywhere else would split the word; it stays a hyphenated line until you edit it.

## Lines you didn't touch

The most important thing the editor leaves alone is the rest of the paragraph. A block opens with every line break the page made, every line's own baseline and indent, and every line's own word gap. The first edit lets the text flow again from that point onward; the lines above it keep their printed layout. Nothing is re-justified, re-kerned or re-wrapped because you clicked.

## What you can't do, by design

You can't edit a scanned page's text, because there's no OCR; you can annotate on top. You can't open a password-protected file. And you can't merge, split, compress, convert or fill forms, because Edit My PDF opens one PDF and writes one PDF. For those jobs the [comparison pages](/compare) say which tool to use instead.
`;

const EDIT_FREE = `
You need to change one date in a PDF. That's the whole job.

So you search "edit PDF online free", click the first result, and twenty seconds later you're creating an account, accepting a cookie banner the length of a short novel, and uploading the file to a company you'd never heard of a minute ago. For one date.

I built Edit My PDF because I kept ending up in exactly that spot. This guide shows how to edit a PDF for free in your browser without uploading it anywhere, and then spends a while on why I think the "without uploading it" part matters more than most of the "best free PDF editor" lists let on.

## The short version

::: steps
- **Open Edit My PDF.** [Open it](/app) in Chrome, Edge, Firefox or Safari. No account, nothing to install.
- **Drop your PDF onto the page.** It opens from your disk and stays on your disk.
- **Click the line you want to change and type.** The line opens in the page's own font, at the same size and colour.
- **Download.** You get a normal PDF with real, selectable text. No watermark.
:::

That's genuinely it. If that was all you came for, go and fix your date. The rest of this is for anyone who wants to know why "no upload" is the headline.

![Edit a PDF in four steps: open your PDF, click any line, type your change, download. No sign-up, no upload, no watermark, about a minute, zero accounts created.](/blog/four-steps.webp#1600x1726 "Four steps, about a minute, zero accounts. The whole job happens in your browser tab.")

## Why "free" PDF editors usually aren't

Servers cost money. When a website processes your PDF on its own machines, somebody is paying for the electricity, the disks and the people who keep it all running, and that money has to come from somewhere. It usually comes from you, in one of a few currencies.

A watermark across your contract, which looks very professional. A task limit: two free edits a day, then a friendly pop-up about a subscription. A sign-up wall, where the edit is free but downloading it needs an account. Or the file itself, which travels to their server and sits there for a while.

![A bingo card of free PDF editor catches: create an account to download, a watermark on every page, a daily task limit, your file kept for hours on a server, a file size cap, new text in the wrong font, an upgrade pop-up, and deletion within a reasonable period. Edit My PDF scores zero squares.](/blog/bingo.webp#1600x1699 "Free PDF editor bingo. Most tools can fill a row before you have changed a word.")

The first three are irritating. The fourth is the one I'd actually think about.

## Where your PDF goes

Here's the usual sequence when you "edit a PDF online":

1. Your browser uploads the **entire file** to the company's server.
2. The server opens it, applies your change and stores the result.
3. You download the new file.
4. The original and the result stay on that server for a while.

How long is a while? When I was writing the [comparison pages](/compare) I read the published retention policies of a dozen popular tools. The answers were one hour, two hours, 24 hours, "within a reasonable period" and "until you delete it". A couple also send document content to third-party AI services for their AI features.

I don't think any of this is sinister. Most of these companies are doing their best. But think about what actually goes into PDFs: bank statements, payslips, tax forms, medical letters, a contract, a passport scan. Each upload is another copy of your private life on another computer you don't control, protected by another company's security team on a day you'll never hear about.

![Two routes for one PDF edit. A typical online editor uploads the file to its server, keeps it for one hour to indefinitely, then sends it back. Edit My PDF opens, edits and rebuilds the file inside your browser tab, then saves it to your Downloads: zero kilometres travelled.](/blog/road-trip.webp#1600x1574 "Same edit, two routes. Only one of them needs your file to leave home.")

## How this one works without a server

Edit My PDF has no server to upload to. I mean that literally: the project has no backend code at all. When you open the site, your browser downloads the app (some JavaScript, fonts and icons) and from then on everything happens inside your tab.

Reading is done by pdf.js, the same engine Firefox uses to show PDFs. Your edits are a list kept in the tab's memory next to the file. Saving writes the file and that list into your browser's own storage on your disk, so a refresh doesn't lose anything. Downloading means pdf-lib builds the new PDF right there in the tab and your browser saves it like any other download.

So who can see your PDF? You. That's the list. The website that serves the app can see that somebody loaded it, in the way every website sees a visit, and it never receives your document, your edits or even the file's name, because the app never sends them. If you want the long version, I wrote up [how Edit My PDF is built](/blog/nothing-leaves-your-browser), and the [privacy page](/privacy) lists exactly what the site does and doesn't collect.

## It edits the text that's already there

A lot of "PDF editors" let you put a white box over the old words and type new ones on top in Arial. From across the room it looks fine. Up close, your carefully typeset invoice now has one line in a different font, a bit too big and a bit too low.

I wanted the harder thing. When you click a line in Edit My PDF, it opens in the PDF's own embedded font at its exact size, colour, letter spacing and word spacing. When you download, the edit is written back as real text in a subset of that same font, so it can still be selected, searched and copied like the rest of the page.

::: pair Cover-up editors | Edit My PDF
- A white box hides the old text
- New text in a substitute font
- Spacing that never quite matches
---
- The original text is replaced
- The page's own font, size and colour
- Real, searchable text in the export
:::

## What else you can do while you're in there

Fix typos, dates, names, prices or whole paragraphs; bold and italic runs keep their style. Sign, either by typing your name in a handwriting style or by uploading a photo of your real signature (more on that in [how to sign a PDF without uploading it](/blog/sign-pdf-online-free-without-uploading)). Mark pages up with the pencil, rectangles, ellipses, lines and arrows, plus an emoji if a document really needs one. And undo any of it. The documents screen keeps your recent files in this browser so you can come back to them.

## What it won't do

I'd rather say this now than have you find out at 11:58pm before a deadline. There's no OCR, so a scanned page is a picture and its words can't be retyped. There's no conversion to Word or Excel. No merging, splitting or compressing, and no form filling yet. Your documents live in this browser only, so they don't sync to your other devices. If you need any of those, the [comparisons](/compare) say plainly which tools do them.

## Questions I get asked

### Is it really free?

Yes. There's no paid plan, no trial and no watermark. The code is open source under the MIT licence, and since there are no servers running your edits, there's no processing bill for anyone to claw back.

### Do I need to sign up or install anything?

No. Open the page and drop a PDF in. No email address, no password to forget.

### Can I edit a PDF without Adobe Acrobat?

For changing existing text, adding a signature and marking up pages, yes, a browser editor does the job. You'll still want a full desktop suite for OCR or for preflight checks before print.

### Is it safe to edit confidential PDFs?

The file never leaves your computer, which removes the biggest risk: a copy of it on someone else's server. Your own computer still matters, of course. A dodgy browser extension can read any page you have open, so be choosy about those.

### Does it work on a Mac, Windows or a Chromebook?

It runs in current Chrome, Edge, Firefox and Safari, so Windows, macOS, Linux and ChromeOS are all fine. Phones work too, though the panels are happier on a laptop or tablet.

## Go fix that date

You came here to change one line. [Open Edit My PDF](/app), drop the file in, click the line, type. The PDF stays home the whole time, which is where it should have been all along.
`;

const SIGN_FREE = `
Somebody has emailed you a PDF with "please sign and return" in the subject line.

Ten years ago that meant print it, sign it, find a scanner, discover the scanner is out of toner, photograph it with your phone instead and email back a slightly crooked JPEG. Today you can sign a PDF online for free in about a minute. The catch is that most "sign PDF online" tools want the document uploaded first, and the documents we sign are, almost by definition, the most personal files we own. This guide is about signing one without the file ever leaving your computer.

## Signing a PDF in about a minute

::: steps
- **Open your PDF.** Go to [Edit My PDF](/app) and drop the file onto the page. It opens from your disk; nothing is uploaded.
- **Choose Sign.** It's in the tool rail on the left, or press <kbd>G</kbd>.
- **Make your signature.** Type your name and pick a handwriting style, or upload a photo or scan of your real signature (PNG, JPEG or WebP).
- **Place it.** Click where it goes, drag to move it, pull a corner to resize.
- **Download.** The signed PDF lands in your Downloads folder.
:::

![Sign a PDF in 60 seconds: open the PDF at 0:00, choose Sign at 0:10, type or upload your signature at 0:20, place it at 0:40, download at 0:55. Your saved signature lives only in this browser's storage.](/blog/sign-in-60.webp#1600x1256 "From inbox to signed in about a minute. No printer, no scanner, no upload.")

Once you've placed a signature, the editor keeps it in this browser's storage so it's one click away next time. It isn't sent anywhere, because there's nowhere for it to go. Clear your browser data and it's gone.

## Why signing deserves a bit more care than other edits

Think about the last few things you signed. A lease. An offer letter. A loan application. A medical consent form. An NDA. Now think about what was in them.

![Anatomy of a lease agreement: full legal name, home address, date of birth, phone and email, income and salary, bank details, ID or passport number and your signature, all in one PDF.](/blog/whats-inside.webp#1600x1501 "One lease agreement, eight things an identity thief would love. Sensitivity: five flames.")

A typical document you're asked to sign has your full name, home address, date of birth, salary, bank details and an ID number on it, and then, on top of all that, a picture of your signature. That's not so much a file as a starter kit.

Upload it to a free online signing tool and a copy of all of it lives on a server for a while. The retention windows I found in the published policies of popular PDF tools run from an hour to "until you delete it", and signed documents tend to be kept longer than other files, because e-signature services keep records. I don't think these companies are villains. I just think the safest copy of your data is the one that was never made, and with Edit My PDF there's no server behind the editor, so there's no copy to leak, keep, back up or forget about. Your PDF goes from your disk to your screen to your Downloads folder.

## Electronic signature or digital signature?

The two terms get mixed up constantly, and the difference does matter.

::: pair Electronic signature | Digital signature
A picture or typed version of your signature placed on the document. This is what you get when you "sign" a PDF in most free tools, including this one. It's what everyday paperwork asks for: leases, permission slips, invoices, timesheets, HR forms.
---
A cryptographic seal tied to a certificate that proves who signed and that nothing changed afterwards. It needs a certificate from a trust provider and is used for some legal, government and financial filings. Edit My PDF doesn't create these.
:::

If a document says it needs a "certified", "qualified" or "digital" signature, ask the sender what they'll accept. For an ordinary "please sign and return", a typed or drawn signature is what they mean. I make an editor, not legal advice.

## Typed or uploaded?

Typed: you type your name and pick a handwriting style. Ten seconds, looks tidy, and nobody has to know that your real signature looks like a seismograph reading. Uploaded: you sign a sheet of white paper, take a well-lit photo or scan it, and upload that. It looks exactly like you, because it is you.

Either way the image stays in your browser. There's no "us" on the other end to see it.

## Don't take my word for it

Every PDF website says your files are safe, including this one. You don't have to trust any of us. Your browser can show you every request a page makes, and an upload is hard to hide, because it's a request about as big as your file.

![A 60-second test: open the developer tools and the Network tab, use the PDF tool, then look for a request as big as your PDF. If you find one, your file went on a trip. If nothing carries your file, it stayed home.](/blog/network-test.webp#1600x1390 "The Network-tab test. Works on any PDF tool, takes a minute.")

::: steps
- **Open the developer tools.** Press <kbd>⌥ ⌘ I</kbd> on a Mac or <kbd>Ctrl ⇧ I</kbd> on Windows, Linux and ChromeOS, then pick the **Network** tab.
- **Use the tool.** Open a PDF, sign it, download it.
- **Read the list.** Sort by size. If one request is about as big as your PDF, that was your PDF leaving the building.
:::

With Edit My PDF you'll see the app loading its own files and nothing that carries your document. That isn't a promise in a policy. It's how the thing is built, and you can check it in a minute.

## While you're in there

You can fix a typo before you sign: click any line and retype it in the page's own font. You can initial every page with the same saved signature. The pencil, shapes and text tool cover the tick boxes and notes that aren't proper form fields. And there's no watermark, so your signed contract won't advertise anyone.

What it doesn't do: certificate-based digital signatures, sending a document out for other people to sign, audit trails, and fillable form fields (not yet). If you need a multi-party signing workflow, you want a dedicated e-signature service. For "sign this and send it back", you don't.

## Questions I get asked

### Is it free to sign a PDF with Edit My PDF?

Yes, completely. No account, no trial, no limit on how many documents you sign, no watermark.

### Is my signature stored anywhere?

Only in your own browser's storage on your own computer, so you can reuse it. It's never uploaded. Clearing your browser data removes it.

### Can I sign a PDF on a Mac or Windows without Adobe?

Yes. It runs in Chrome, Edge, Firefox and Safari, so Windows, macOS, Linux and Chromebooks all work, with nothing to install.

### Is a typed signature legally valid?

In many countries an electronic signature, typed or drawn, is accepted for everyday agreements. The rules depend on where you are and what you're signing, so when it matters, ask the person who sent the document what they accept.

### Can I sign on my phone?

The editor runs in mobile Safari and Chrome and understands touch for drawing, dragging and pinch zoom. It's more comfortable on a laptop or tablet, but a phone will do in a pinch.

## Sign it where it already is

The document is already on your computer. So is your signature. Neither of them needs a trip to somebody else's. [Open Edit My PDF](/app), sign, download, done.
`;

const RELEASE_RESOURCES = `
Edit My PDF now opens three kinds of PDF it used to show only in part: scanned documents, pages with Chinese, Japanese or Korean text, and files that carry their own colour profile. The privacy promise didn't move to make this happen. Every file the editor needs still comes from this site, and nothing you open leaves your browser.

## What you'll notice

::: cards
- {{image}} **Scans show their pages.** Scanned PDFs often store each page as a JPEG 2000 or JBIG2 image, the formats of fax machines and document scanners. Those pages used to come up blank. They now appear.
- {{languages}} **Chinese, Japanese and Korean text appears.** A PDF can set these languages in a font it doesn't include, trusting the reader to know the character map. The editor now has the maps.
- {{palette}} **Colours follow the file.** Some PDFs include an ICC profile, a note saying exactly what their colours mean. The editor now honours it instead of taking a close guess.
- {{type}} **Bullets and symbols use the right face.** Text in the classic Symbol or ZapfDingbats fonts, common for bullet points in older documents, draws with a proper stand-in.
:::

You don't have to do anything. Open a PDF as usual and, if it's one of these kinds, it looks right.

<figure>
<div class="bp-dg" aria-hidden="true">
<div class="bp-pg"><div class="bp-ba"><div class="bp-mini-page bp-narrow"><i class="bp-ln bp-w6 bp-head"></i><span class="bp-pic bp-missing"></span><i class="bp-ln bp-w9"></i><i class="bp-ln bp-w7"></i></div><span class="bp-dg-arrow">→</span><div class="bp-mini-page bp-narrow"><i class="bp-ln bp-w6 bp-head"></i><span class="bp-pic"></span><i class="bp-ln bp-w9"></i><i class="bp-ln bp-w7"></i></div></div><span class="bp-dg-label">A scanned page: blank before, the page itself now</span></div>
<div class="bp-pg"><div class="bp-ba"><div class="bp-mini-page bp-narrow"><i class="bp-ln bp-w6 bp-head"></i><i class="bp-ln bp-w9"></i><i class="bp-ln bp-w8 bp-ghost"></i><i class="bp-ln bp-w7"></i></div><span class="bp-dg-arrow">→</span><div class="bp-mini-page bp-narrow"><i class="bp-ln bp-w6 bp-head"></i><i class="bp-ln bp-w9"></i><span class="bp-text">日本語テスト</span><i class="bp-ln bp-w7"></i></div></div><span class="bp-dg-label">Japanese text: a gap before, the words now</span></div>
<div class="bp-pg"><div class="bp-ba"><div class="bp-mini-page bp-narrow"><i class="bp-ln bp-w6 bp-head"></i><span class="bp-swatch" style="--sw: #d98a6a"></span><i class="bp-ln bp-w9"></i><i class="bp-ln bp-w6"></i></div><span class="bp-dg-arrow">→</span><div class="bp-mini-page bp-narrow"><i class="bp-ln bp-w6 bp-head"></i><span class="bp-swatch" style="--sw: #c8102e"></span><i class="bp-ln bp-w9"></i><i class="bp-ln bp-w6"></i></div></div><span class="bp-dg-label">A colour profile: a close guess before, the file's own colour now</span></div>
</div>
<figcaption>The three kinds of page this release changes, before and after. The documents themselves are untouched; the editor simply reads them in full.</figcaption>
</figure>

## How a PDF reader works, roughly

Edit My PDF reads PDFs with pdf.js, the open-source reader built into Firefox. pdf.js comes in two parts. There's the engine, which the editor has always shipped. And there's a set of helper files the engine loads only when a document needs them: two picture decoders, for JPEG 2000 and JBIG2 images, compiled to WebAssembly (a way of running programs written in languages like C inside a browser tab, quickly and safely); a colour engine, also WebAssembly, with a profile that describes printing inks; 168 character maps for Chinese, Japanese and Korean fonts; and fourteen stand-in fonts for PDFs that name a font without including it.

The engine has to be told where those files live. Until this release the editor shipped the engine on its own, so a scanned page had no decoder to call, a Japanese line had no map, and the colour engine stayed switched off. Now the helper files travel with the app and the engine knows exactly where they are.

## Why I didn't point it at someone else's server

The quick fix is one line: point pdf.js at a public CDN that hosts these files for anyone. Most examples online do exactly that, and I was tempted for about a minute.

The reason I didn't is that it would quietly break the one promise this editor is built on. Edit My PDF makes no request to anybody else's server while you work. A CDN would learn that someone, at some address, opened a PDF with a Japanese font at a particular time. That isn't your document, but it isn't nothing either, and it's exactly the kind of thing I said I'd never send. I also want the editor to work offline eventually, which means every file it needs has to be part of the app.

<figure>
<div class="bp-dg bp-flow" aria-hidden="true">
${tile("file-text", "Your PDF", "opened from your disk")}
<span class="bp-flow-arrow">→</span>
${tile("cpu", "Your browser tab", "pdf.js reads it with helper files that ship with the app")}
<span class="bp-flow-arrow">→</span>
${tile("eye", "Your screen", "scans, Asian-language text and colours as intended")}
${tile("cloud-off", "A public CDN", "never asked: the helper files come from editmypdf.dev", "bp-flow-tile bp-off")}
</div>
<figcaption>Where a document goes when you open it. The new helper files live with the app, so the path is the same as before: your disk, your tab, your screen.</figcaption>
</figure>

## How the helper files ship with the app

The work happens when the site is built, not when you use it. Every build:

::: steps
- **Copies the helper files out of pdf.js.** The decoders, the colour engine and its ink profile, the 168 character maps and the 14 stand-in fonts come straight from the pdf.js package the editor already depends on.
- **Puts them in a folder with a fingerprint in its name.** The folder's name ends in a short code worked out from the files' contents. When pdf.js is updated, the contents change, the code changes, and no browser can confuse the old files with the new.
- **Tells the engine the address.** Whenever the editor opens a document, it hands pdf.js the folder's address on this site. Every request stays on editmypdf.dev.
:::

The folder is about 3.5 megabytes, but almost nobody downloads it. pdf.js fetches a file the first time a document needs it, and a PDF with its own fonts embedded, ordinary JPEG pictures and screen colours fetches nothing. The app you load grew by 181 bytes, which is the note saying where the folder is.

The fingerprint in the folder's name is there because browsers keep copies of files they've downloaded. That's great until a file changes and the browser keeps using the old copy. With a fingerprint of the contents in the name, a changed file has a changed address and the stale copy is never asked for.

There's also a new rule in the code checker: the editor opens PDFs through exactly one door, and the checker refuses code that tries to go around it. I added that after finding that the little thumbnails on the documents screen had a door of their own, and had missed the helper files entirely.

## How I tested it

Most PDFs never touch these files, so testing with ordinary documents proves nothing. I built four tiny PDFs with a Python script, each about a kilobyte, each asking one question: a gradient picture saved as JPEG 2000; black shapes saved as JBIG2; a colour profile with its red and blue primaries swapped, so a square that's red in the file turns blue only if the colour engine is really running; and a line of Japanese text in a font the file doesn't include, with some bullet points in the Symbol font.

Before this release: blank, blank, red, missing. Now: gradient, shapes, blue, 日本語テスト, and the browser console, which used to show a warning for each, is quiet. The JBIG2 one took two tries. Pillow stores 1-bit images with black and white the opposite way round from JBIG2, and my first test page was a white rectangle on a black page.

## Also fixed: a one-byte font bug in exports

While checking the Symbol bullets I found something older. When you edit text and download, the editor writes a slimmed-down copy of each font into the new PDF, with just the characters your edit needs. For one family of fonts, the kind built on compact outlines, the library doing the slimming was writing a wrong value into one byte of the font's header.

Most PDF readers never look at that byte. Browsers do: Chrome and Firefox run every font through a checker called the OpenType Sanitizer before drawing with it, and it refused those fonts, so an edit in such a font opened in a fallback face in any browser-based reader, this editor included. I'd assumed the bug was something about Symbol, so I made a control PDF in an ordinary font of the same kind, edited a word and exported it. Same bad byte. It had been there for every font of that kind the editor ever exported.

<figure>
<div class="bp-dg" aria-hidden="true">
<div class="bp-pg"><div class="bp-glyph-grid bp-bytes"><b>01</b><b>00</b><b>04</b><b class="bp-bad">16</b></div><span class="bp-dg-label">Before: the fourth byte of an exported font's header, which must be 1 to 4, held a number that was neither</span></div>
<span class="bp-dg-arrow">→</span>
<div class="bp-pg"><div class="bp-glyph-grid bp-bytes"><b>01</b><b>00</b><b>04</b><b class="bp-on">04</b></div><span class="bp-dg-label">Now: the editor sets it to 4 on the way out, and browsers accept the font</span></div>
</div>
<figcaption>The whole bug, in four bytes. Everything else about the font was fine.</figcaption>
</figure>

The editor now checks that byte on the way out and sets it to a valid value. The exported fonts pass the sanitizer, load in the browser and open in the editor with the right glyphs.

## What it means for your documents

Scans from a copier, forms from a government site, a paper in Japanese or Korean, a brochure with print-ready colours. These are everyday PDFs, and they now open the way their makers intended. Because the helper files are part of the app, they'll keep working when the app runs offline, which is where I'm heading next.

If you read code, the build step that ships the helper files is in \`vite.config.ts\`, the one door is \`openDocument\` in \`src/pdf.ts\`, and the byte repair is \`src/soundFontkit.ts\`.
`;

export const POSTS: Post[] = [
  {
    slug: "scans-cjk-text-and-colour-profiles",
    title: "Now open as intended: scans, Chinese, Japanese and Korean text, and colour profiles",
    description:
      "Scanned pages, Chinese, Japanese and Korean text and ICC colour now open as the file intends, and still nothing leaves this site. What changed, how it works, and the one-byte font bug I found on the way.",
    date: "2026-11-09",
    tags: ["release", "pdf", "privacy"],
    keywords: [
      "pdf editor scanned pdf blank page",
      "jpeg 2000 pdf",
      "jbig2 pdf",
      "pdf japanese text missing",
      "pdf cjk font",
      "icc colour profile pdf",
      "private pdf editor no cdn",
      "pdf.js wasmUrl cMapUrl standardFontDataUrl",
    ],
    cover: { glyph: "JP2", hue: "accent" },
    image: {
      src: "/blog/cards/scans-cjk-text-and-colour-profiles.png",
      alt: "A page with a scanned picture, a line of Japanese text and a colour block, with icons for images, languages and colour beside it.",
      width: 1200,
      height: 630,
    },
    thumbnail: "/blog/cards/scans-cjk-text-and-colour-profiles.webp",
    body: RELEASE_RESOURCES,
  },
  {
    slug: "edit-pdf-online-free-without-uploading",
    title: "How to edit a PDF online for free, without uploading it",
    description:
      "How to edit the text in a PDF for free, in your browser, with no sign-up, no watermark and no upload, and why I think that last part matters most.",
    date: "2026-11-04",
    tags: ["how-to", "privacy"],
    keywords: [
      "edit pdf online free",
      "free pdf editor",
      "pdf editor no sign up",
      "edit pdf without uploading",
      "edit text in pdf",
      "pdf editor no watermark",
      "private pdf editor",
      "edit pdf without adobe",
    ],
    cover: { glyph: "0 km", hue: "teal" },
    image: {
      src: "/blog/cards/edit-pdf-online-free-without-uploading.png",
      alt: "A page with one edited line, a crossed-out upload cloud, and the words 0 km travelled by your file.",
      width: 1200,
      height: 630,
    },
    thumbnail: "/blog/cards/edit-pdf-online-free-without-uploading.webp",
    body: EDIT_FREE,
  },
  {
    slug: "sign-pdf-online-free-without-uploading",
    title: "How to sign a PDF online for free, without uploading it",
    description:
      "Add a typed or uploaded signature to a PDF in about a minute, free, with no account and no upload. Also: electronic versus digital signatures, and a one-minute way to check any tool's privacy claims.",
    date: "2026-11-04",
    tags: ["how-to", "privacy", "signatures"],
    keywords: [
      "sign pdf online free",
      "add signature to pdf",
      "electronic signature free",
      "sign pdf without uploading",
      "how to sign a pdf",
      "sign pdf without adobe",
      "e-sign pdf",
    ],
    cover: { glyph: "J.D.", hue: "violet" },
    image: {
      src: "/blog/cards/sign-pdf-online-free-without-uploading.png",
      alt: "A page with a signature drawn above its signature line, and a pen icon.",
      width: 1200,
      height: 630,
    },
    thumbnail: "/blog/cards/sign-pdf-online-free-without-uploading.webp",
    body: SIGN_FREE,
  },
  {
    slug: "exporting-real-text",
    title: "Exporting edits as real text, in the page's own font",
    description:
      "How Edit My PDF removes the original strings from a page's content stream, embeds a subset of the font pdf.js decoded, and writes your edit as positioned text rather than a picture.",
    date: "2026-10-28",
    tags: ["export", "fonts", "pdf-lib"],
    cover: { glyph: "Tj", hue: "accent" },
    image: {
      src: "/blog/cards/exporting-real-text.png",
      alt: "A page with a line of real text beside a font's glyph grid reduced to the few glyphs an edit uses, and the Tj operator.",
      width: 1200,
      height: 630,
    },
    thumbnail: "/blog/cards/exporting-real-text.webp",
    body: EXPORT,
  },
  {
    slug: "what-the-editor-leaves-alone",
    title: "What the editor leaves alone",
    description:
      "Covered text, tables, Type 3 fonts, form XObjects, phantom spaces and the lines you didn't touch: the deliberate limits of editing a PDF in place.",
    date: "2026-10-21",
    tags: ["limits", "design"],
    cover: { glyph: "Ø", hue: "coral" },
    image: {
      src: "/blog/cards/what-the-editor-leaves-alone.png",
      alt: "A page whose table and a covered text block are outlined with dashes and marked with a slashed zero, beside a raised-hand icon.",
      width: 1200,
      height: 630,
    },
    thumbnail: "/blog/cards/what-the-editor-leaves-alone.webp",
    body: LEAVES_ALONE,
  },
  {
    slug: "mixed-face-paragraphs",
    title: "Editing a paragraph that mixes bold, italic and regular as one block",
    description:
      "A textarea holds one font. A paragraph with a bold lead-in needs a contentEditable editor that owns its DOM, maps every edit into styled spans and keeps the page's line layout.",
    date: "2026-10-14",
    tags: ["editor", "fonts"],
    cover: { glyph: "Aa", hue: "violet" },
    image: {
      src: "/blog/cards/mixed-face-paragraphs.png",
      alt: "A paragraph selected as one block, with bold and italic runs inside it, and the letters Aa.",
      width: 1200,
      height: 630,
    },
    thumbnail: "/blog/cards/mixed-face-paragraphs.webp",
    body: MIXED,
  },
  {
    slug: "exactly-as-the-page-prints-it",
    title: "Opening an element exactly as the page prints it",
    description:
      "Fitting every run and line to its printed width, keeping a block's own baselines and breaks, measuring the baseline in the browser, and reading colour from the pixels.",
    date: "2026-10-07",
    tags: ["fidelity", "layout"],
    cover: { glyph: "Tw", hue: "teal" },
    image: {
      src: "/blog/cards/exactly-as-the-page-prints-it.png",
      alt: "A page with one line outlined exactly at its printed width on its baseline, a ruler along the bottom, and the Tw operator.",
      width: 1200,
      height: 630,
    },
    thumbnail: "/blog/cards/exactly-as-the-page-prints-it.webp",
    body: EXACT,
  },
  {
    slug: "nothing-leaves-your-browser",
    title: "Nothing leaves your browser: how Edit My PDF is built",
    description:
      "pdf.js in a web worker, pdf-lib for writing, IndexedDB for storage and no server at all. What that architecture buys, what it costs, and how to check it yourself.",
    date: "2026-09-30",
    tags: ["privacy", "architecture"],
    cover: { glyph: "{ }", hue: "teal" },
    image: {
      src: "/blog/cards/nothing-leaves-your-browser.png",
      alt: "A browser window at editmypdf.dev holding a page whose edit loops back inside it, a crossed-out server beside it, and a pair of braces.",
      width: 1200,
      height: 630,
    },
    thumbnail: "/blog/cards/nothing-leaves-your-browser.webp",
    body: PRIVACY_POST,
  },
  {
    slug: "why-editing-pdf-text-is-hard",
    title: "Why editing text inside a PDF is hard",
    description:
      "No paragraphs, subset fonts with no space glyph, spacing operators that leak, phantom spaces, mixed faces and browsers that round: the real reasons a click can shift a line.",
    date: "2026-09-16",
    tags: ["fonts", "pdf"],
    cover: { glyph: "¶", hue: "violet" },
    image: {
      src: "/blog/cards/why-editing-pdf-text-is-hard.png",
      alt: "A page where the letters of Revenue grew sit in separate boxes with a kerning value between the words, and a pilcrow.",
      width: 1200,
      height: 630,
    },
    thumbnail: "/blog/cards/why-editing-pdf-text-is-hard.webp",
    body: WHY_HARD,
  },
];

export function postBySlug(slug: string): Post | undefined {
  return POSTS.find((post) => post.slug === slug);
}

// Up to `count` other posts, the ones sharing the most tags first; when fewer than `count` share a
// tag, the most recent remaining posts fill the list so the section is never empty.
export function relatedPosts(post: Post, count = 3): Post[] {
  const shared = (other: Post) => other.tags.filter((tag) => post.tags.includes(tag)).length;
  return POSTS.filter((other) => other.slug !== post.slug)
    .map((other, index) => ({ other, score: shared(other), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, count)
    .map((entry) => entry.other);
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}
