import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Link, useParams } from "react-router";
import { ArrowRight, BookOpen, ChevronDown, ChevronRight, ListTree } from "lucide-react";
import { formatDate, postBySlug, relatedPosts } from "../data/posts.ts";
import { PRODUCT, ROUTES, siteOrigin } from "../data/product.ts";
import { Markdown } from "./Markdown.tsx";
import { headingsOf, readingTime, type Heading } from "./markdown.ts";
import { NotFound } from "./NotFound.tsx";
import { PostCard } from "./PostCard.tsx";
import { breadcrumbs, useMeta } from "./useMeta.ts";
import "./blog.css";

export function BlogPost() {
  const { slug = "" } = useParams();
  const post = postBySlug(slug);
  if (!post) return <NotFound />;
  return <Article slug={slug} />;
}

// The sticky header's height plus a little, so a heading scrolled to sits below it.
const HEADER_OFFSET = 96;

// "In this post": the post's headings, the one being read highlighted. A sidebar on wide screens;
// above the text, folded, on narrow ones.
function Toc({ headings }: { headings: Heading[] }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const nodes = headings.map((heading) => document.getElementById(heading.id)).filter((node): node is HTMLElement => node !== null);
    if (nodes.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      // The active section is the last heading at or above the reading line.
      let current = nodes[0].id;
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= HEADER_OFFSET + 24) current = node.id;
        else break;
      }
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [headings]);

  // The jump is done here rather than left to the browser so the sticky header never covers the
  // heading and the router is not involved. On a narrow screen the list folds first, and the
  // target is measured on the next frame, after the fold has shortened the page above it.
  const jump = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (!document.getElementById(id)) return;
    event.preventDefault();
    setOpen(false);
    history.replaceState(null, "", `#${id}`);
    requestAnimationFrame(() => {
      const node = document.getElementById(id);
      if (!node) return;
      const top = node.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
    });
  };

  if (headings.length === 0) return null;
  return (
    <nav className={open ? "toc open" : "toc"} aria-label="In this post">
      <button type="button" className="toc-toggle" aria-expanded={open} aria-controls="toc-list" onClick={() => setOpen((value) => !value)}>
        <ListTree aria-hidden="true" />
        <span>In this post</span>
        <small>{headings.length} sections</small>
        <ChevronDown aria-hidden="true" className="toc-chevron" />
      </button>
      <p className="toc-title">
        <ListTree aria-hidden="true" /> In this post
      </p>
      <ol id="toc-list" className="toc-list">
        {headings.map((heading) => (
          <li key={heading.id} className={`toc-item depth-${heading.depth}${heading.id === active ? " active" : ""}`}>
            <a href={`#${heading.id}`} aria-current={heading.id === active ? "location" : undefined} onClick={(event) => jump(event, heading.id)}>
              {heading.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Article({ slug }: { slug: string }) {
  const post = postBySlug(slug)!;
  const minutes = readingTime(post.body);
  const headings = useMemo(() => headingsOf(post.body), [post.body]);
  const related = relatedPosts(post, 3);
  useMeta({
    title: post.title,
    description: post.description,
    type: "article",
    keywords: [...post.tags, ...(post.keywords ?? [])],
    image: post.image,
    article: { published: post.date, tags: post.tags },
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: post.title,
        description: post.description,
        datePublished: post.date,
        dateModified: post.date,
        author: { "@type": "Organization", name: PRODUCT.name },
        publisher: { "@type": "Organization", name: PRODUCT.name },
        keywords: [...post.tags, ...(post.keywords ?? [])].join(", "),
        ...(post.image ? { image: `${siteOrigin()}${post.image.src}` } : {}),
        timeRequired: `PT${minutes}M`,
      },
      breadcrumbs([
        { name: "Blog", path: ROUTES.blog },
        { name: post.title, path: ROUTES.post(post.slug) },
      ]),
    ],
  });
  return (
    <article className={`section container post-layout tone-${post.cover.hue}`}>
      <header className="post-header">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to={ROUTES.home}>{PRODUCT.name}</Link>
          <ChevronRight aria-hidden="true" />
          <Link to={ROUTES.blog}>Blog</Link>
        </nav>
        <p className="eyebrow">
          <BookOpen aria-hidden="true" /> {post.tags.join(" · ")}
        </p>
        <h1 className="display">{post.title}</h1>
        <p className="lede">{post.description}</p>
        <div className="post-meta">
          <time dateTime={post.date}>{formatDate(post.date)}</time>
          <span>{minutes} min read</span>
        </div>
      </header>
      <div className="post-main">
        <aside className="post-side">
          <Toc headings={headings} />
        </aside>
        <div className="post-body">
          <Markdown source={post.body} />
        </div>
      </div>
      <footer className="post-footer tone-violet">
        <div className="post-related">
          <p className="eyebrow">
            <BookOpen aria-hidden="true" /> Related posts
          </p>
          <div className="post-grid">
            {related.map((other) => (
              <PostCard key={other.slug} post={other} />
            ))}
          </div>
        </div>
        <p className="actions">
          <Link to={ROUTES.app} className="btn btn-primary">
            Try it on a PDF <ArrowRight className="btn-arrow" aria-hidden="true" />
          </Link>
          <Link to={ROUTES.blog} className="btn btn-secondary">
            All posts
          </Link>
        </p>
      </footer>
    </article>
  );
}
