import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { annotatedDownloadName } from "./downloadName.ts";

describe("annotatedDownloadName", () => {
  it("adds a single -annotated suffix", () => {
    assert.equal(annotatedDownloadName("report.pdf"), "report-annotated.pdf");
    assert.equal(annotatedDownloadName("Report.PDF"), "Report-annotated.pdf");
  });

  it("does not stack -annotated on a second download", () => {
    assert.equal(annotatedDownloadName("report-annotated.pdf"), "report-annotated.pdf");
    assert.equal(
      annotatedDownloadName(annotatedDownloadName("x.pdf")),
      "x-annotated.pdf",
    );
  });
});
