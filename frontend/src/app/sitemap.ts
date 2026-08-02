import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes: MetadataRoute.Sitemap = [
    { url: "/", changeFrequency: "weekly", priority: 1 },
    { url: "/features", changeFrequency: "monthly", priority: 0.85 },
    { url: "/pricing", changeFrequency: "monthly", priority: 0.8 },
    { url: "/contact", changeFrequency: "monthly", priority: 0.75 },
    { url: "/accessibilite", changeFrequency: "yearly", priority: 0.4 },
    { url: "/faq", changeFrequency: "monthly", priority: 0.65 },
    { url: "/conformite", changeFrequency: "monthly", priority: 0.7 },
    { url: "/security", changeFrequency: "yearly", priority: 0.4 },
    { url: "/confiance", changeFrequency: "monthly", priority: 0.6 },
    { url: "/legal/mentions", changeFrequency: "yearly", priority: 0.3 },
    { url: "/legal/privacy", changeFrequency: "yearly", priority: 0.3 },
    { url: "/legal/terms", changeFrequency: "yearly", priority: 0.3 },
    { url: "/legal/cgv", changeFrequency: "yearly", priority: 0.3 },
    { url: "/legal/dpa", changeFrequency: "yearly", priority: 0.3 },
    { url: "/legal/cookies", changeFrequency: "yearly", priority: 0.3 },
    { url: "/legal/einvoicing-scope", changeFrequency: "yearly", priority: 0.3 },
  ];
  return routes;
}
