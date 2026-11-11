import { useEffect } from "react";
import { useLocation } from "react-router";
import { PRODUCT, siteOrigin } from "../data/product.ts";
import { canonicalPath } from "../data/routes.ts";

export type PageMeta = {
  // The full <title>; pass `titleSuffix: false` to use it verbatim.
  title: string;
  titleSuffix?: boolean;
  description: string;
  type?: "website" | "article";
  // Image for link previews: its address absolute, or relative to the site (the base path is
  // added); defaults to the site card.
  image?: { src: string; alt: string; width: number; height: number };
  keywords?: string[];
  noindex?: boolean;
  // For a blog post: the dates and tags go out as article:* tags.
  article?: { published: string; modified?: string; tags?: string[] };
  jsonLd?: Record<string, unknown> | Record<string, unknown>[];
};

// The site card's dimensions and alt text, the same for every page that uses it.
const CARD = { width: 1200, height: 630, alt: "Edit My PDF: edit the text in a PDF without disturbing the page" };

// The head tags a page resolves to, with URLs made absolute where the origin is known.
export type ResolvedMeta = {
  siteName: string;
  title: string;
  description: string;
  robots: string;
  keywords: string;
  type: "website" | "article";
  url: string;
  image: string;
  imageWidth: string;
  imageHeight: string;
  imageAlt: string;
  locale: string;
  articlePublished: string;
  articleModified: string;
  articleTags: string[];
  // Serialised JSON-LD, or "" when the page has none.
  jsonLd: string;
};

export function resolveMeta(meta: PageMeta, pathname: string): ResolvedMeta {
  const origin = siteOrigin();
  const image = meta.image ?? { src: "/og.png", ...CARD };
  return {
    siteName: PRODUCT.name,
    title: meta.titleSuffix === false ? meta.title : `${meta.title} — ${PRODUCT.name}`,
    description: meta.description,
    robots: meta.noindex ? "noindex, nofollow" : "index, follow",
    keywords: meta.keywords?.join(", ") ?? "",
    type: meta.type ?? "website",
    url: `${origin}${canonicalPath(pathname)}`,
    image: image.src.startsWith("http") ? image.src : `${origin}${image.src}`,
    imageWidth: String(image.width),
    imageHeight: String(image.height),
    imageAlt: image.alt,
    locale: "en_GB",
    articlePublished: meta.article?.published ?? "",
    articleModified: meta.article?.modified ?? meta.article?.published ?? "",
    articleTags: meta.article?.tags ?? [],
    jsonLd: meta.jsonLd ? JSON.stringify(meta.jsonLd) : "",
  };
}

// Effects never run at build time, so while the prerender renders a page (import.meta.env.SSR) the
// page's meta is recorded here during render and scripts/prerender.mjs reads it back afterwards,
// through entry-server.tsx. Pages render one at a time, so one slot is enough.
let rendered: ResolvedMeta | null = null;

export function takeRenderedMeta(): ResolvedMeta | null {
  const meta = rendered;
  rendered = null;
  return meta;
}

function setTag(selector: string, create: () => HTMLElement, apply: (node: HTMLElement) => void) {
  let node = document.head.querySelector<HTMLElement>(selector);
  if (!node) {
    node = create();
    document.head.append(node);
  }
  apply(node);
}

// Sets the tag, or removes it when the page has no value (a post's article tags must not
// linger on the next page).
function setMeta(attribute: "name" | "property", key: string, content: string) {
  if (!content) {
    document.head.querySelectorAll(`meta[${attribute}="${key}"]`).forEach((node) => node.remove());
    return;
  }
  setTag(
    `meta[${attribute}="${key}"]`,
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute(attribute, key);
      return meta;
    },
    (node) => node.setAttribute("content", content),
  );
}

// Sets the document title, description, Open Graph and Twitter tags, canonical link and JSON-LD.
// Prerendered pages arrive with the same tags already in <head> (written by scripts/prerender.mjs
// with the selectors used here), so this updates them in place rather than adding a second set.
export function useMeta(meta: PageMeta): void {
  const { pathname } = useLocation();
  const resolved = resolveMeta(meta, pathname);
  if (import.meta.env.SSR) rendered = resolved;
  const { title, description, robots, keywords, type, url, image, imageWidth, imageHeight, imageAlt, locale, articlePublished, articleModified, jsonLd } = resolved;
  const articleTags = resolved.articleTags.join("\n");
  useEffect(() => {
    document.title = title;
    setMeta("name", "description", description);
    setMeta("name", "robots", robots);
    if (keywords) setMeta("name", "keywords", keywords);
    setMeta("property", "og:site_name", PRODUCT.name);
    setMeta("property", "og:title", title);
    setMeta("property", "og:description", description);
    setMeta("property", "og:type", type);
    setMeta("property", "og:url", url);
    setMeta("property", "og:image", image);
    setMeta("property", "og:image:width", imageWidth);
    setMeta("property", "og:image:height", imageHeight);
    setMeta("property", "og:image:alt", imageAlt);
    setMeta("property", "og:locale", locale);
    setMeta("property", "article:published_time", articlePublished);
    setMeta("property", "article:modified_time", articleModified);
    document.head.querySelectorAll('meta[property="article:tag"]').forEach((node) => node.remove());
    for (const tag of articleTags ? articleTags.split("\n") : []) {
      const node = document.createElement("meta");
      node.setAttribute("property", "article:tag");
      node.setAttribute("content", tag);
      document.head.append(node);
    }
    setMeta("name", "twitter:card", "summary_large_image");
    setMeta("name", "twitter:title", title);
    setMeta("name", "twitter:description", description);
    setMeta("name", "twitter:image", image);
    setTag(
      'link[rel="canonical"]',
      () => {
        const link = document.createElement("link");
        link.rel = "canonical";
        return link;
      },
      (node) => node.setAttribute("href", url),
    );
    const existing = document.head.querySelector('script[data-page-ld="true"]');
    if (jsonLd) {
      const script = existing ?? document.createElement("script");
      script.setAttribute("type", "application/ld+json");
      script.setAttribute("data-page-ld", "true");
      script.textContent = jsonLd;
      if (!existing) document.head.append(script);
    } else {
      existing?.remove();
    }
  }, [title, description, robots, keywords, type, url, image, imageWidth, imageHeight, imageAlt, locale, articlePublished, articleModified, articleTags, jsonLd]);
}

// A BreadcrumbList for a page two or three levels deep.
export function breadcrumbs(items: { name: string; path: string }[]): Record<string, unknown> {
  const origin = siteOrigin();
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [{ name: PRODUCT.name, path: "/" }, ...items].map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${origin}${canonicalPath(item.path)}`,
    })),
  };
}
