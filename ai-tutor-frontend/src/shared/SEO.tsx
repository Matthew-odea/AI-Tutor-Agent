import { Helmet } from "react-helmet-async";

/**
 * Props for the SEO component
 */
interface SEOProps {
  /** Page title - will be appended with site name */
  title?: string;
  /** Meta description for search engines */
  description?: string;
  /** Keywords for the page (comma-separated) */
  keywords?: string;
  /** Canonical URL for the page */
  url?: string;
  /** Open Graph image URL */
  image?: string;
  /** Page type (website, article, etc.) */
  type?: "website" | "article";
  /** Whether this page should be indexed by search engines */
  noIndex?: boolean;
}

/**
 * SEO component for managing document head meta tags
 *
 * Handles title, meta descriptions, Open Graph tags, Twitter cards,
 * and structured data for search engine optimization.
 *
 * @example
 * ```tsx
 * <SEO
 *   title="Chat Interface"
 *   description="Interactive AI tutoring chat"
 *   url="https://example.com/chat"
 * />
 * ```
 */
export default function SEO({
  title = "AI Tutor",
  description = "An intelligent AI tutoring system that helps you learn programming through interactive conversations and code examples.",
  keywords = "AI tutor, programming education, code learning, interactive learning, Python tutor",
  url = "https://ai-tutor.example.com",
  image = "https://ai-tutor.example.com/og-image.png",
  type = "website",
  noIndex = false,
}: SEOProps) {
  const siteTitle = "AI Tutor";
  const fullTitle = title === siteTitle ? title : `${title} | ${siteTitle}`;

  return (
    <Helmet>
      {/* Primary Meta Tags */}
      <title>{fullTitle}</title>
      <meta name="title" content={fullTitle} />
      <meta name="description" content={description} />
      <meta name="keywords" content={keywords} />

      {/* Robots */}
      {noIndex && <meta name="robots" content="noindex,nofollow" />}

      {/* Open Graph / Facebook */}
      <meta property="og:type" content={type} />
      <meta property="og:url" content={url} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={image} />
      <meta property="og:site_name" content={siteTitle} />

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:url" content={url} />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />

      {/* Additional Meta Tags */}
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta httpEquiv="Content-Type" content="text/html; charset=utf-8" />
      <meta name="language" content="English" />
      <meta name="author" content="AI Tutor Team" />

      {/* Canonical URL */}
      <link rel="canonical" href={url} />
    </Helmet>
  );
}
