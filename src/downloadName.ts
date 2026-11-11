/** Download basename with a single "-annotated" suffix before ".pdf". */
export function annotatedDownloadName(name: string): string {
  return name.replace(/(?:-annotated(?: \(\d+\))?)?(?:\.pdf)?$/i, "") + "-annotated.pdf";
}
