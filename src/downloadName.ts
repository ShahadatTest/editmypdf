/** Download basename with a single `-annotated` suffix before `.pdf`. */
export function annotatedDownloadName(name: string): string {
  const base = name.replace(/\.pdf$/i, "");
  if (/-annotated$/i.test(base)) {
    return `${base}.pdf`;
  }
  return `${base}-annotated.pdf`;
}
