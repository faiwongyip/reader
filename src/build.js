/**
 * 🦉 Bubo RSS Reader
 * ====
 * Dead, dead simple feed reader that renders an HTML
 * page with links to content from feeds organized by site
 *
 */

import Parser from 'rss-parser';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { template } from './template.js';

const WRITE = process.argv.includes('--write');
const USE_CACHE = !WRITE && process.argv.includes('--cached');

const CACHE_PATH = './src/cache.json';
const OUTFILE_PATH = './output/index.html';
const FETCH_TIMEOUT = 15000;
const FETCH_RETRIES = 2;

const config = readCfg('./src/config.json');
const feeds = USE_CACHE ? {} : readCfg('./src/feeds.json');
const cache = USE_CACHE ? readCfg(CACHE_PATH) : {};

await build({ config, feeds, cache, writeCache: WRITE });

async function build({ config, feeds, cache, writeCache = false }) {
  let allItems = cache.allItems || [];
  const parser = new Parser();
  const errors = [];
  const groupContents = {};

  for (const groupName in feeds) {
    groupContents[groupName] = [];

    const results = await Promise.allSettled(
      Object.values(feeds[groupName]).map(url =>
        fetchTextWithRetry(url)
          .then(body => [url, body])
          .catch(e => {
            throw [url, e];
          })
      )
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        const [url, error] = result.reason;
        errors.push(url);
        console.error(`Error fetching ${url}:\n`, error);
        continue;
      }

      const [url, body] = result.value;

      try {
        if (!body.trim()) throw new Error('empty content');
        const contents = await parser.parseString(body);
        const isRedditRSS = contents.feedUrl && contents.feedUrl.includes("reddit.com/r/");

        if (!contents.items || contents.items.length === 0)
          throw Error(`Feed at ${url} contains no items.`)

        contents.feed = url;
        contents.title = contents.title || contents.link;
        groupContents[groupName].push(contents);

        // item sort & normalization
        contents.items.sort(byDateSort);
        contents.items.forEach((item) => {
          // 1. try to normalize date attribute naming
          const dateAttr = item.pubDate || item.isoDate || item.date || item.published;
          const date = dateAttr ? new Date(dateAttr) : null;
          item.timestamp = date && !Number.isNaN(date.getTime())
            ? date.toLocaleDateString()
            : '';

          // 2. resolve relative link urls against the feed link
          try { item.link = new URL(item.link, contents.link).href; } catch {}

          // 3. parse subreddit feed comments
          if (isRedditRSS && item.contentSnippet?.startsWith('submitted by    ') && item.content) {
            // matches anything between double quotes, like `<a href="matches this">foo</a>`
            const quotesContentMatch = /(?<=")(?:\\.|[^"\\])*(?=")/g;
            const parts = item.content.split('<a href=');
            const contentLink = parts[2]?.match(quotesContentMatch)?.[0];
            const commentsLink = parts[3]?.match(quotesContentMatch)?.[0];
            if (contentLink) item.link = contentLink;
            if (commentsLink) item.comments = commentsLink;
          }

          // 4. redirects
          if (config.redirects && item.link) {
            try {
              // need to parse hostname methodically due to unreliable feeds
              const u = new URL(item.link);
              const tokens = u.hostname.split('.');
              const host = tokens[tokens.length - 2];
              const redirect = config.redirects[host];
              if (redirect) item.link = `https://${redirect}${u.pathname}${u.search}`;
            } catch (e) {
              console.warn(`跳过无效链接: ${item.link}`);
            }
          }

          // 5. escape html in titles
          item.title = escapeHtml(item.title ?? '');
        });

        // add to allItems
        allItems = [...allItems, ...contents.items];
      } catch (e) {
        errors.push(url);
        console.error(`[FEED ERROR] URL: ${url} Type: parse — ${e.message}`);
      }
    }
  }

  const groups = cache.groups || Object.entries(groupContents);

  if (writeCache) {
    writeFileSync(
      resolve(CACHE_PATH),
      JSON.stringify({ groups, allItems }),
      'utf8'
    );
  }

  // for each group, sort the feeds
  // sort the feeds by comparing the isoDate of the first items of each feed
  groups.forEach(([_groupName, feeds]) => {
    feeds.sort((a, b) => byDateSort(a.items[0], b.items[0]));
  });

  // sort `all articles` view
  allItems.sort((a, b) => byDateSort(a, b));

  const now = getNowDate(config.timezone_offset).toString();
  const html = template({ allItems, groups, now, errors });

  writeFileSync(resolve(OUTFILE_PATH), html, { encoding: 'utf8' });
  console.log(`Reader built successfully at: ${OUTFILE_PATH}`);
}

/**
 * utils
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTextWithRetry(url) {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    // Use an explicit, ref'd timer. `AbortSignal.timeout()` is unref'd, so a
    // stalled request can let the event loop drain and Node exits with code 13
    // ("unsettled top-level await") before the abort ever fires.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'Accept':
            'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, */*'
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        if (!retryable || attempt === FETCH_RETRIES)
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        await sleep((attempt + 1) * 1500);
        continue;
      }

      return await response.text();
    } catch (error) {
      const code = error?.cause?.code || error?.code;
      const retryable =
        error?.name === 'AbortError' ||
        ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
      if (!retryable || attempt === FETCH_RETRIES) throw error;
      await sleep((attempt + 1) * 1500);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseDate(item) {
  let date = item
    ? (item.isoDate || item.pubDate)
    : undefined;

  return date ? new Date(date) : undefined;
}

function byDateSort(dateStrA, dateStrB) {
  const [aDate, bDate] = [parseDate(dateStrA), parseDate(dateStrB)];
  if (!aDate || !bDate) return 0;
  return bDate - aDate;
}

function getNowDate(offset = 0) {
  let d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  d = new Date(utc + (3600000 * offset));
  return d;
}

function readCfg(path) {
  let contents, json;

  try {
    contents = readFileSync(resolve(path), { encoding: 'utf8' });
  } catch (e) {
    console.warn(`Warning: Config at ${path} does not exist`);
    return {};
  }

  try {
    json = JSON.parse(contents);
  } catch (e) {
    console.error('Error: Config is Invalid JSON: ' + path);
    process.exit(1);
  }

  return json;
}


function escapeHtml(html) {
  return (html ?? '').replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\'', '&apos;')
    .replaceAll('"', '&quot;');
}
