import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { formatDate, type Post } from "../data/posts.ts";
import { publicUrl, ROUTES } from "../data/product.ts";
import { readingTime } from "./markdown.ts";
import "./blog.css";

// A post's cover: the scene drawn for it by scripts/blog-cards.mjs when it has one (the same
// picture as its link preview, without the title, which the card sets below), otherwise a page on
// a tinted ground with the post's glyph set large in the display face. The drawn fallback is SVG,
// so it is crisp at any size and takes its colours from the theme.
export function PostCover({
  post,
  className = "post-cover",
  loading = "lazy",
}: {
  post: Post;
  className?: string;
  // "eager" for the cards in view when a page opens, so their pictures start with the page.
  loading?: "eager" | "lazy";
}) {
  const { glyph, hue } = post.cover;
  if (post.thumbnail) {
    return (
      <img
        className={`${className} post-cover-image`}
        src={publicUrl(post.thumbnail)}
        alt=""
        width={1200}
        height={600}
        loading={loading}
        decoding="async"
      />
    );
  }
  // "Aa" shows the mixed faces the post is about.
  const letters =
    glyph === "Aa" ? (
      <>
        <tspan fontWeight="700">A</tspan>
        <tspan fontStyle="italic">a</tspan>
      </>
    ) : (
      glyph
    );
  return (
    <svg className={`${className} tone-${hue}`} viewBox="0 0 320 160" aria-hidden="true" focusable="false">
      <defs>
        <pattern id={`dots-${post.slug}`} width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" className="post-cover-dot" />
        </pattern>
      </defs>
      <rect width="320" height="160" className="post-cover-ground" />
      <rect width="320" height="160" fill={`url(#dots-${post.slug})`} />
      <g className="post-cover-page">
        <rect x="34" y="28" width="118" height="150" rx="4" />
        <g className="post-cover-lines">
          <rect x="50" y="46" width="52" height="5" rx="2.5" />
          <rect x="50" y="60" width="86" height="4" rx="2" />
          <rect x="50" y="71" width="78" height="4" rx="2" />
          <rect x="50" y="82" width="84" height="4" rx="2" />
          <rect x="50" y="93" width="60" height="4" rx="2" />
          <rect x="50" y="112" width="86" height="4" rx="2" />
          <rect x="50" y="123" width="70" height="4" rx="2" />
          <rect x="50" y="134" width="82" height="4" rx="2" />
        </g>
        <rect x="50" y="81" width="54" height="6" rx="2" className="post-cover-edit" />
      </g>
      <text x="228" y="104" textAnchor="middle" className="post-cover-glyph">
        {letters}
      </text>
    </svg>
  );
}

// One blog post as a card: cover, date and reading time, title, excerpt, tags.
export function PostCard({
  post,
  heading: Heading = "h3",
  eager = false,
}: {
  post: Post;
  heading?: "h2" | "h3";
  eager?: boolean;
}) {
  return (
    <Link to={ROUTES.post(post.slug)} className="post-card">
      <PostCover post={post} loading={eager ? "eager" : "lazy"} />
      <div className="post-card-body">
        <div className="card-meta">
          <time dateTime={post.date}>{formatDate(post.date)}</time>
          <span>{readingTime(post.body)} min read</span>
        </div>
        <Heading>{post.title}</Heading>
        <p>{post.description}</p>
        <div className="post-card-foot">
          <span className="post-card-tags">
            {post.tags.map((tag) => (
              <span key={tag} className="tag">
                {tag}
              </span>
            ))}
          </span>
          <span className="link-arrow">
            Read <ArrowRight aria-hidden="true" />
          </span>
        </div>
      </div>
    </Link>
  );
}
