import Anthropic from "@anthropic-ai/sdk";
import { XMLParser } from "fast-xml-parser";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

interface Article {
  title: string;
  link: string;
  pubDate: Date;
  source: string;
  description: string;
  summary?: string;
}

interface FeedConfig {
  name: string;
  url: string;
}

const FEEDS: FeedConfig[] = [
  {
    name: "TechCrunch AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
  },
  {
    name: "The Verge AI",
    url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
  },
  {
    name: "Hacker News",
    url: "https://hnrss.org/newest?q=AI&count=10",
  },
];

const TWENTY_FOUR_HOURS = 48 * 60 * 60 * 1000;
const SUMMARIZE_BATCH_SIZE = 5;

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    if (typeof v["__cdata"] === "string") return v["__cdata"];
    if (typeof v["#text"] === "string") return v["#text"];
  }
  return "";
}

async function fetchFeed(feed: FeedConfig): Promise<Article[]> {
  const res = await fetch(feed.url, {
    headers: { "User-Agent": "ai-news-digest/1.0" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${feed.url}`);
  }

  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: "__cdata" });
  const parsed = parser.parse(xml);

  const channel = parsed?.rss?.channel ?? parsed?.feed;
  if (!channel) throw new Error(`Unexpected feed structure for ${feed.name}`);

  const items: unknown[] = Array.isArray(channel.item)
    ? channel.item
    : channel.item
    ? [channel.item]
    : Array.isArray(channel.entry)
    ? channel.entry
    : channel.entry
    ? [channel.entry]
    : [];

  const cutoff = Date.now() - TWENTY_FOUR_HOURS;

  return items
    .map((item: unknown) => {
      const i = item as Record<string, unknown>;
      const rawDate = (i.pubDate ?? i.published ?? i.updated ?? "") as string;
      const pubDate = new Date(rawDate);

      const rawLink = i.link;
      const link =
        typeof rawLink === "string"
          ? rawLink
          : (rawLink as Record<string, unknown>)?.["@_href"]
          ? String((rawLink as Record<string, unknown>)["@_href"])
          : "";

      const title = extractText(i.title).trim();

      const rawDesc = i.description ?? i.summary ?? i["content:encoded"] ?? "";
      const description = stripHtml(extractText(rawDesc)).slice(0, 1500);

      return { title, link, pubDate, source: feed.name, description };
    })
    .filter(
      (a) =>
        a.title &&
        a.link &&
        !isNaN(a.pubDate.getTime()) &&
        a.pubDate.getTime() > cutoff
    );
}

async function summarizeArticles(articles: Article[]): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠ ANTHROPIC_API_KEY not set — skipping AI summaries");
    return;
  }

  const client = new Anthropic();
  let done = 0;

  for (let i = 0; i < articles.length; i += SUMMARIZE_BATCH_SIZE) {
    const batch = articles.slice(i, i + SUMMARIZE_BATCH_SIZE);

    await Promise.all(
      batch.map(async (article) => {
        const context = article.description
          ? `标题：${article.title}\n\n内容：${article.description}`
          : `标题：${article.title}`;

        try {
          const response = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 256,
            messages: [
              {
                role: "user",
                content: `请用不超过100字的中文总结以下新闻，直接输出摘要，不要加任何前缀：\n\n${context}`,
              },
            ],
          });
          const block = response.content.find((b) => b.type === "text");
          if (block?.type === "text") article.summary = block.text.trim();
        } catch (err) {
          console.error(`\n✗ Summary failed for "${article.title}": ${err}`);
        } finally {
          done++;
          process.stdout.write(`\r  Summarizing: ${done}/${articles.length}`);
        }
      })
    );
  }

  process.stdout.write("\n");
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

function formatDate(date: Date): string {
  return date
    .toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Asia/Shanghai",
    })
    .replace(/\//g, "-");
}

function renderMarkdown(articles: Article[], date: Date): string {
  const bySource = new Map<string, Article[]>();

  for (const a of articles) {
    if (!bySource.has(a.source)) bySource.set(a.source, []);
    bySource.get(a.source)!.push(a);
  }

  const sourceCount = bySource.size;
  const lines: string[] = [
    `# AI 日报 ${formatDate(date)}`,
    "",
    `> 共收录 **${articles.length}** 篇，来自 **${sourceCount}** 个源`,
    "",
  ];

  for (const [source, items] of bySource) {
    lines.push(`## ${source} (${items.length} 篇)`, "");
    for (const a of items) {
      lines.push(`- [${a.title}](${a.link}) — ${formatTime(a.pubDate)}`);
      if (a.summary) {
        lines.push(`  > ${a.summary}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  console.log("Fetching RSS feeds...");

  const results = await Promise.allSettled(FEEDS.map(fetchFeed));

  const articles: Article[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      console.log(`✓ ${FEEDS[i].name}: ${result.value.length} articles`);
      articles.push(...result.value);
    } else {
      console.error(`✗ ${FEEDS[i].name}: ${result.reason}`);
    }
  }

  articles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  console.log("\nGenerating AI summaries...");
  await summarizeArticles(articles);

  const now = new Date();
  const markdown = renderMarkdown(articles, now);
  const filename = `${formatDate(now)}.md`;

  const outputDir = join(process.cwd(), "output");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, filename), markdown, "utf-8");

  console.log(`\nSaved to output/${filename}`);
  console.log(
    `Total: ${articles.length} articles from ${new Set(articles.map((a) => a.source)).size} sources`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
