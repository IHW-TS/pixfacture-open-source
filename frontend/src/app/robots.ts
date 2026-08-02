import type { MetadataRoute } from "next";
import { toAbsoluteUrl } from "@/lib/metadata";

export default function robots(): MetadataRoute.Robots {
  const sitemapUrl = toAbsoluteUrl("/sitemap.xml");
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/app/", "/q/", "/i/", "/c/", "/admin/"],
    },
    ...(sitemapUrl ? { sitemap: sitemapUrl } : {}),
  };
}
