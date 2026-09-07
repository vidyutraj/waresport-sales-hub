import type { MetadataRoute } from 'next';

/**
 * This is an internal workspace holding prospect contact details. It should
 * never appear in a search index, so nothing here is crawlable. The matching
 * `X-Robots-Tag` header in next.config.ts covers crawlers that fetch a URL
 * directly without reading robots.txt first.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: '/' }],
  };
}
