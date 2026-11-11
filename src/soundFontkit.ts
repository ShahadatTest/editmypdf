import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument } from "pdf-lib";

// pdf-lib's fontkit types, which it does not export; read off the method that takes them.
type Fontkit = Parameters<PDFDocument["registerFontkit"]>[0];
type Subset = ReturnType<ReturnType<Fontkit["create"]>["createSubset"]>;
type SubsetStream = ReturnType<Subset["encodeStream"]>;

// fontkit's CFF subsetter fills the header's offSize byte with a value that is not an offset size
// (CFFSubset.encode sets `offSize: this.cff.length`; 16 and 11 in the fonts checked). Anything
// outside 1–4 there makes the OpenType sanitizer that Chrome and Firefox run on every web font
// refuse the font ("CFF: Bad offSize") and pdf.js stop recognising it as CFF, so an exported edit
// in a CFF-based face (a Type1C or CIDFontType0C font, or a standard font pdf.js converted from
// Type1) is drawn in a fallback face by browser-based readers, this editor included. The byte is
// informational, each INDEX carries its own offset size, so this fontkit hands pdf-lib the same
// subsets with that byte set to 4. TrueType subsets begin with 00 01 00 00 or "true" and pass
// through untouched.
export const soundFontkit: Fontkit = {
  create(buffer, postscriptName) {
    const font = fontkit.create(buffer, postscriptName);
    // A font collection has no subsetter; pdf-lib reports that itself when it tries to use it.
    if (typeof font.createSubset !== "function") return font;
    const createSubset = font.createSubset.bind(font);
    font.createSubset = () => soundSubset(createSubset());
    return font;
  },
};

function soundSubset(subset: Subset): Subset {
  const encodeStream = subset.encodeStream.bind(subset);
  subset.encodeStream = () => soundStream(encodeStream());
  return subset;
}

// pdf-lib reads a subset through the "data" events of `subset.encodeStream()` and joins the chunks
// (CustomFontSubsetEmbedder.serializeFont in pdf-lib 1.17); the header sits at the start of the
// first chunk. Should a pdf-lib upgrade take the bytes another way, this hook would no longer run,
// so a CFF subset in an export failing Chrome's sanitizer again is the sign to look here.
function soundStream(stream: SubsetStream): SubsetStream {
  let first = true;
  const sound: SubsetStream = {
    on(eventType, callback) {
      stream.on(eventType, (data) => {
        if (eventType === "data" && first) {
          first = false;
          data = soundCffHeader(data);
        }
        callback(data);
      });
      return sound;
    },
  };
  return sound;
}

// A bare CFF begins 01 00 04 <offSize>, and the offset size has to be 1 to 4.
function soundCffHeader(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 1 || bytes[1] !== 0 || bytes[2] !== 4) return bytes;
  if (bytes[3] >= 1 && bytes[3] <= 4) return bytes;
  const fixed = new Uint8Array(bytes);
  fixed[3] = 4;
  return fixed;
}
