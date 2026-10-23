window.SITE_CONFIG = {
  site: {
    title: "PacketPerf Home",
    tagline: "Dynatrace news hub",
  },

  // Published by the "Dynatrace news" GitHub Actions workflow (news/fetch-news.mjs)
  // to the public Pages site of LBN-PP/pp_home — only site/ is published, this
  // private repo's HTML/config/branding never are. GitHub Pages sends
  // `Access-Control-Allow-Origin: *`, so fetch() works cross-origin with no extra setup.
  data: {
    newsUrl: "https://lbn-pp.github.io/pp_home/data/news.json",
  },

  // Shortcuts rendered in the top bar as mini-cards (logo + name).
  // Icon resolution: by default the remote site's favicon is fetched automatically.
  // To override it, add an `svg` field with raw inline SVG markup — it takes priority.
  // Demo set below: real, well-known tool homepages. Replace with your team's own links.
  shortcuts: [
    { label: "Dynatrace News", url: "https://www.dynatrace.com/news/" },
    { label: "Dynatrace Docs", url: "https://www.dynatrace.com/support/help/" },
    { label: "Community", url: "https://community.dynatrace.com/" },
    {
      label: "Status",
      url: "https://status.dynatrace.com/",
      svg: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12h4l2.5-7 5 14L16 12h6" stroke="#f7930d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    },
    { label: "GitHub", url: "https://github.com/" },
    { label: "GitLab", url: "https://gitlab.com/" },
    { label: "Jira", url: "https://www.atlassian.com/software/jira" },
    { label: "Confluence", url: "https://www.atlassian.com/software/confluence" },
    { label: "Slack", url: "https://slack.com/" },
    { label: "PagerDuty", url: "https://www.pagerduty.com/" },
    { label: "Grafana", url: "https://grafana.com/" },
    { label: "Prometheus", url: "https://prometheus.io/" },
    { label: "Kubernetes", url: "https://kubernetes.io/" },
    { label: "AWS Console", url: "https://console.aws.amazon.com/" },
    { label: "Azure Portal", url: "https://portal.azure.com/" },
    { label: "Google Cloud", url: "https://console.cloud.google.com/" },
    { label: "npm", url: "https://www.npmjs.com/" },
    { label: "Docker Hub", url: "https://hub.docker.com/" },
    { label: "Postman", url: "https://www.postman.com/" },
    { label: "Notion", url: "https://www.notion.so/" },
  ],
};
