// Sidebar order. Every slug must have a content/<slug>.md (or be generated).
export const NAV = [
  {
    title: "Getting started",
    pages: [
      { slug: "index", title: "Introduction" },
      { slug: "quickstart", title: "Quick start" },
      { slug: "installation", title: "Installation" },
      { slug: "configuration", title: "Configuration" },
    ],
  },
  {
    title: "Concepts",
    pages: [
      { slug: "concepts/jobs", title: "Jobs" },
      { slug: "concepts/retries", title: "Retries, timeouts and the DLQ" },
      { slug: "concepts/workflows", title: "Workflows" },
      { slug: "concepts/cron", title: "Cron schedules" },
      { slug: "concepts/workers", title: "Remote workers" },
      { slug: "concepts/auth", title: "Authentication and tenants" },
    ],
  },
  {
    title: "SDKs and tools",
    pages: [
      { slug: "sdks/typescript", title: "TypeScript" },
      { slug: "sdks/python", title: "Python" },
      { slug: "sdks/go", title: "Go" },
      { slug: "sdks/rust", title: "Rust" },
      { slug: "cli", title: "CLI" },
    ],
  },
  {
    title: "Reference",
    pages: [
      { slug: "api", title: "REST API" },
      { slug: "deployment", title: "Production deployment" },
      { slug: "internals", title: "How it works" },
      { slug: "examples", title: "Examples" },
    ],
  },
];
