import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { annotatedDownloadName } from "./downloadName.ts";

describe("annotatedDownloadName", () => {
  it("adds a single -annotated suffix", () => {
    assert.equal(annotatedDownloadName("report.pdf"), "report-annotated.pdf");
    assert.equal(annotatedDownloadName("Report.PDF"), "Report-annotated.pdf");
  });

  it("normalizes a browser-renamed annotated download", () => {
    assert.equal(annotatedDownloadName("x-annotated (1).pdf"), "x-annotated.pdf");
    assert.equal(annotatedDownloadName("Report-ANNOTATED (12).PDF"), "Report-annotated.pdf");
  });

  it("keeps copy counters on ordinary names and accepts names without extensions", () => {
    assert.equal(annotatedDownloadName("draft (1).pdf"), "draft (1)-annotated.pdf");
    assert.equal(annotatedDownloadName("draft"), "draft-annotated.pdf");
  });

  it("does not stack -annotated on a second download", () => {
    assert.equal(annotatedDownloadName("report-annotated.pdf"), "report-annotated.pdf");
    assert.equal(
      annotatedDownloadName(annotatedDownloadName("x.pdf")),
      "x-annotated.pdf",
    );
  });
});
