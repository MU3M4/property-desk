import { readFileSync } from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';
import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePrice(s) {
  if (typeof s === 'number') return isNaN(s) ? '' : s;
  if (!s) return '';
  const str = String(s).trim();
  if (/price on application|poa|contact for price/i.test(str)) return '';

  // Take the starting number if it's a range like "8.5M - 12M" or "8,000,000 - 12,000,000"
  const firstPart = str.split(/[-–—/]| to /i)[0].trim();

  // Check for Million: e.g. "15.5M", "15.5 M", "15 Million", "15m"
  const mMatch = firstPart.match(/([\d,.]+)\s*(?:m(?:illion)?)\b/i);
  if (mMatch) {
    const val = parseFloat(mMatch[1].replace(/,/g, ''));
    if (!isNaN(val)) return Math.round(val * 1_000_000);
  }

  // Check for Thousand: e.g. "85K", "85 Thousand", "85k"
  const kMatch = firstPart.match(/([\d,.]+)\s*(?:k(?:|ilo|thousand)?)\b/i);
  if (kMatch) {
    const val = parseFloat(kMatch[1].replace(/,/g, ''));
    if (!isNaN(val)) return Math.round(val * 1_000);
  }

  // Standard digit extract (e.g. "KES 14,000,000" -> 14000000)
  const d = firstPart.replace(/[^\d]/g, '');
  return d ? Number(d) : '';
}

function parseBeds(s) {
  if (typeof s === 'number') return isNaN(s) ? '' : s;
  if (!s) return '';
  const str = String(s).trim();
  if (/studio|bedsitter/i.test(str)) return 0;
  const match = str.match(/(\d+)\s*(?:bed|br)/i);
  if (match) return Number(match[1]);
  const d = str.replace(/[^\d]/g, '');
  return d ? Number(d) : '';
}

function parseSize(s) {
  if (typeof s === 'number') return isNaN(s) ? '' : s;
  if (!s) return '';
  const str = String(s).trim();
  // If in sqft, convert to m² (1 sqft ≈ 0.092903 m²)
  const sqftMatch = str.match(/([\d,.]+)\s*(?:sq\s*ft|sqft|ft²)/i);
  if (sqftMatch) {
    const sqft = parseFloat(sqftMatch[1].replace(/,/g, ''));
    if (!isNaN(sqft)) return Math.round(sqft * 0.092903);
  }
  const d = str.replace(/[^\d]/g, '');
  return d ? Number(d) : '';
}

async function allowed(url, ua) {
  const u = new URL(url);
  const robotsUrl = `${u.origin}/robots.txt`;
  try {
    const r = await fetch(robotsUrl, {
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return false; // cannot read robots.txt: do not collect
    return robotsParser(robotsUrl, await r.text()).isAllowed(url, ua) !== false;
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const startTime = Date.now();
  const TIME_BUDGET_MS = 50000; // 50s budget leaves 10s buffer before Vercel 60s hard timeout

  const cfg = JSON.parse(readFileSync(path.join(process.cwd(), 'sources.json'), 'utf8'));
  const ua = `PropertyDeskBot/0.1 (contact: ${cfg.contact_email})`;
  const today = new Date().toISOString().slice(0, 10);

  let redis;
  try {
    redis = Redis.fromEnv();
  } catch (err) {
    return res.status(500).json({ error: 'Redis configuration missing or invalid: ' + err.message });
  }

  const log = [];
  const fresh = [];
  const okSources = new Set();
  let timedOut = false;

  sourceLoop: for (const src of cfg.sources) {
    if (!src.permission_confirmed) {
      log.push(`skip ${src.name}: permission not confirmed`);
      continue;
    }

    // Ingest verified direct units (e.g. from developer price sheets or modern SPA portals)
    if (Array.isArray(src.units) && src.units.length > 0) {
      for (const u of src.units) {
        fresh.push({
          title: u.title,
          area: u.area || src.area || '',
          status: u.status || src.status || 'ready-sale',
          type: u.type || src.type || 'apartment',
          beds: parseBeds(u.beds),
          price: parsePrice(u.price),
          size: parseSize(u.size),
          agent: src.name,
          phone: src.publishes_business_contact ? (u.phone || src.phone || '') : '',
          src: u.src || (Array.isArray(src.pages) && src.pages[0]) || '',
          img: u.img || '',
          ver: today,
        });
      }
      okSources.add(src.name);
      log.push(`ok ${src.name}: loaded ${src.units.length} verified units`);
    }

    // Crawl web pages using CSS selectors if provided
    if (src.selectors && Array.isArray(src.pages) && src.pages.length > 0) {
      const s = src.selectors;
      for (const page of src.pages) {
        if (Date.now() - startTime > TIME_BUDGET_MS) {
          log.push(`time budget reached (${Math.round((Date.now() - startTime) / 1000)}s); stopping collection early to persist data`);
          timedOut = true;
          break sourceLoop;
        }

        if (!(await allowed(page, ua))) {
          log.push(`skip ${page}: robots.txt`);
          continue;
        }

        try {
          const r = await fetch(page, {
            headers: { 'User-Agent': ua },
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const $ = cheerio.load(await r.text());
          $(s.card).each((_, el) => {
            const c = $(el);
            const title = c.find(s.title).first().text().trim();
            const area = c.find(s.area).first().text().trim();
            if (!title || !area) return;
            const href = c.find(s.link || 'a').first().attr('href');
            const img = c.find(s.image || 'img').first().attr('src');
            fresh.push({
              title, area, status: src.status, type: src.type,
              beds: parseBeds(c.find(s.beds).first().text()),
              price: parsePrice(c.find(s.price).first().text()),
              size: parseSize(c.find(s.size).first().text()),
              agent: src.name,
              phone: src.publishes_business_contact ? c.find(s.phone).first().text().trim() : '',
              src: href ? new URL(href, page).href : page,
              img: img ? new URL(img, page).href : '',
              ver: today,
            });
          });
          okSources.add(src.name);
          log.push(`ok ${page}`);
        } catch (e) {
        log.push(`fail ${page}: ${e.message}`);
      }
      await sleep(cfg.delay_ms || 3000);
    }
  }

  try {
    const existing = (await redis.get('listings')) || [];
    const kept = existing.filter((x) => !okSources.has(x.agent)); // keep other sources' data
    const all = [...kept, ...fresh];
    await redis.set('listings', all);
    await redis.set('updated', new Date().toISOString());
    res.status(200).json({ collected: fresh.length, total: all.length, timedOut, log });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save to Redis: ' + err.message, log });
  }
}
