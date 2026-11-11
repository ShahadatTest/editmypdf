import { BookOpen } from "lucide-react";
import { POSTS } from "../data/posts.ts";
import { PRODUCT, ROUTES } from "../data/product.ts";
import { PostCard } from "./PostCard.tsx";
import { useMeta } from "./useMeta.ts";

export function Blog() {
  useMeta({
    title: "Blog",
    description: `Engineering notes from building ${PRODUCT.name}: fonts, spacing, content streams, and why editing a PDF in place is hard.`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Blog",
      name: `${PRODUCT.name} blog`,
      blogPost: POSTS.map((post) => ({
        "@type": "BlogPosting",
        headline: post.title,
        datePublished: post.date,
        url: `${ROUTES.post(post.slug)}`,
      })),
    },
  });
  return (
    <section className="section container tone-violet">
      <div className="section-head">
        <p className="eyebrow">
          <BookOpen aria-hidden="true" /> Blog
        </p>
        <h1 className="display">Notes from the inside of a PDF.</h1>
        <p className="lede">
          What it takes to edit a page in place, written from the code that does it, and what each release
          changes for your documents. No roadmap posts, just the engineering.
        </p>
      </div>
      <div className="post-grid">
        {POSTS.map((post, index) => (
          <PostCard key={post.slug} post={post} heading="h2" eager={index < 3} />
        ))}
      </div>
    </section>
  );
}
