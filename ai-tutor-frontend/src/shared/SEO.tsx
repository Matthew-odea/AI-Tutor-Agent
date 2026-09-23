import { Helmet } from "react-helmet-async";

interface SEOProps {
  /** Suffixed with " | AI Tutor" unless it equals the site name */
  title?: string;
  description?: string;
  /** comma-separated */
  keywords?: string;
  url?: string;
  image?: string;
  type?: "website" | "article";
  noIndex?: boolean;
}

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
      <title>{fullTitle}</title>
      <meta name="title" content={fullTitle} />
      <meta name="description" content={description} />
      <meta name="keywords" content={keywords} />

      {noIndex && <meta name="robots" content="noindex,nofollow" />}

      <meta property="og:type" content={type} />
      <meta property="og:url" content={url} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={image} />
      <meta property="og:site_name" content={siteTitle} />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:url" content={url} />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />

      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta httpEquiv="Content-Type" content="text/html; charset=utf-8" />
      <meta name="language" content="English" />
      <meta name="author" content="AI Tutor Team" />

      <link rel="canonical" href={url} />
    </Helmet>
  );
}
