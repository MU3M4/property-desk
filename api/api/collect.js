import { readFileSync } from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';
import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => { const d = String(s || '').replace(/[^\d]/g, ''); return d ? Number(d) : ''; };

async function allowed(url, ua) {
  const u = new URL(url);
  const robotsUrl = `${u.origin}/robots.txt`;
  try {
    const r = await fetch(robotsUrl, { headers: { 'User-Agent': ua } });
    if (!r.ok) return false; // cannot read robots.txt: do not collect
    return robotsParser(robotsUrl, await r.text()).isAllowed(url, ua) !== false;
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const cfg = JSON.parse(readFileSync(path.join(process.cwd(), 'sources.json'), 'utf8'));
  const ua = `PropertyDeskBot/0.1 (contact: ${cfg.contact_email})`;
  const today = new Date().toISOString().slice(0, 10);
  const redis = Redis.fromEnv();
  const log = [];
  const fresh = [];
  const okSources = new Set();

  for (const src of cfg.sources) {
    if (!src.permission_confirmed) { log.push(`skip ${src.name}: permission not confirmed`); continue; }
    const s = src.selectors;
    for (const page of src.pages) {
      if (!(await allowed(page, ua))) { log.push(`skip ${page}: robots.txt`); continue; }
      try {
        const r = await fetch(page, { headers: { 'User-Agent': ua } });
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
            beds: num(c.find(s.beds).first().text()),
            price: num(c.find(s.price).first().text()),
            size: num(c.find(s.size).first().text()),
            agent: src.name,
            phone: src.publishes_business_contact ? c.find(s.phone).first().text().trim() : '',
            src: href ? new URL(href, page).href : page,
            img: img ? new URL(img, page).href : '',
            ver: today,
          });
        });
        okSources.add(src.name);
        log.push(`ok ${page}`);
      } catch (e) { log.push(`fail ${page}: ${e.message}`); }
      await sleep(cfg.delay_ms || 3000);
    }
  }

  const existing = (await redis.get('listings')) || [];
  const kept = existing.filter((x) => !okSources.has(x.agent)); // keep other sources' data
  const all = [...kept, ...fresh];
  await redis.set('listings', all);
  await redis.set('updated', new Date().toISOString());
  res.status(200).json({ collected: fresh.length, total: all.length, log });
}
