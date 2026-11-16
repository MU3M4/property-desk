import crypto from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';

const RA = JSON.parse(readFileSync(path.join(process.cwd(), 'data/riverside-azure.json'), 'utf8'));
const redis = Redis.fromEnv();
const GRAPH = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
const BASE = process.env.PUBLIC_BASE_URL;

const send = (to, payload) => fetch(GRAPH, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ messaging_product: 'whatsapp', to, ...payload }),
});
const text = (to, body) => send(to, { type: 'text', text: { body } });
const raw = (req) => new Promise((ok, no) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no); });

const ORDER = ['name', 'unit', 'budget', 'deposit', 'timeline', 'where'];
const Q = {
  name: 'Great, thank you. What is your name?',
  unit: 'Which unit are you interested in? Reply 1, 2 or 3 for the number of bedrooms.',
  budget: 'What is your approximate budget in KES? Reply with a number (for example 9m) or SKIP.',
  deposit: `The deposit is ${RA.payment.deposit}. Do you have that available now? Reply YES, NO or NOT SURE.`,
  timeline: 'When do you want to buy? Reply 1 for within 3 months, 2 for 3-6 months, 3 for later than 6 months.',
  where: 'Are you in Kenya or abroad? Reply KENYA or ABROAD.',
};

function parseBudget(s) {
  if (/skip/i.test(s)) return '';
  const m = s.replace(/,/g, '').match(/([\d.]+)\s*(m|million|k)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]); const u = (m[2] || '').toLowerCase();
  return Math.round(u.startsWith('m') ? n * 1e6 : u === 'k' ? n * 1e3 : n);
}

function score(d) {
  let s = 0;
  if (d.timeline === 'within 3 months') s += 2; else if (d.timeline === '3-6 months') s += 1;
  if (d.deposit === 'yes') s += 1;
  if (d.budget) s += 1;
  if (d.unit) s += 1;
  return s >= 4 ? 'Hot' : s >= 2 ? 'Warm' : 'Nurture';
}

async function saveLead(from, st) {
  const d = st.d;
  await redis.hset('leads', { [from]: { phone: from, name: d.name, unit: d.unit, budget: d.budget, deposit: d.deposit, timeline: d.timeline, where: d.where, viewing: !!d.viewing, needs_reply: !!d.needs_reply, priority: score(d), consent_on: d.consent_on, updated: new Date().toISOString() } });
}

async function media(to, what) {
  if (what === 'video') return send(to, { type: 'video', video: { link: `${BASE}/media/${RA.media.video}`, caption: 'Riverside Azure walkthrough' } });
  for (const f of RA.media.flyers) await send(to, { type: 'image', image: { link: `${BASE}/media/${f}` } });
}

async function answer(from, t, st) {
  if (/video|tour|walk/.test(t)) { await media(from, 'video'); return; }
  if (/flyer|brochure|photo|picture|image/.test(t)) { await media(from, 'flyers'); return; }
  if (/viewing|visit|site|show/.test(t)) {
    st.d.viewing = true; await saveLead(from, st);
    return text(from, `Noted. The agent will confirm a viewing time with you here. The show apartment is at ${RA.address}.`);
  }
  if (/price|cost|how much/.test(t)) return text(from, 'I do not want to quote a price that may be out of date. The agent will send the current price list for your unit size. Reply VIEWING if you would also like a site visit.');
  if (/deposit|payment|plan|booking|install|pay/.test(t)) return text(from, `Booking fee: ${RA.payment.booking_fee}. Deposit: ${RA.payment.deposit}. The balance is ${RA.payment.balance}.\n\nSteps: ${RA.process.map((p, i) => `${i + 1}) ${p}`).join(' ')}`);
  if (/furnish|offer|promo|november|discount|detail/.test(t)) return text(from, RA.promo);
  if (/where|location|address/.test(t)) return text(from, `${RA.name} is at ${RA.address}. Website: ${RA.website}`);
  st.d.needs_reply = true; await saveLead(from, st);
  return text(from, 'Thanks. I will pass this question to the agent, who will reply here. You can also reply VIDEO, FLYERS, DETAILS or VIEWING.');
}

async function handle(from, msg) {
  const key = `wa:${from}`;
  const t = msg.toLowerCase();
  if (/^(stop|unsubscribe|delete)\b/.test(t)) {
    await redis.del(key); await redis.hdel('leads', from);
    return text(from, 'Done. Your details have been deleted and you will not be contacted. Message us any time to start again.');
  }
  let st = (await redis.get(key)) || { step: 'new', d: {} };
  if (st.step === 'new') {
    st.step = 'consent'; await redis.set(key, st);
    return text(from, `Hello! This is the sales desk for ${RA.name}, an off-plan apartment development at ${RA.address} with 1, 2 and 3-bedroom units. I am an authorised sales agent.\n\nMay I save a few details and contact you on this number about ${RA.name}? Reply YES to continue. Reply STOP at any time to delete your details.`);
  }
  if (st.step === 'consent') {
    if (/^(yes|y|ok|okay|sure)\b/.test(t)) { st.step = 'name'; st.d.consent_on = new Date().toISOString().slice(0, 10); await redis.set(key, st); return text(from, Q.name); }
    return text(from, 'No problem, nothing has been saved. Reply YES if you would like to continue, or STOP.');
  }
  if (ORDER.includes(st.step)) {
    const s = st.step; let ok = true;
    if (s === 'name') st.d.name = msg.slice(0, 60);
    else if (s === 'unit') { const m = t.match(/[123]/); if (m) st.d.unit = `${m[0]}-bedroom`; else ok = false; }
    else if (s === 'budget') { const b = parseBudget(msg); if (b === null) ok = false; else st.d.budget = b; }
    else if (s === 'deposit') { if (/^y/.test(t)) st.d.deposit = 'yes'; else if (/^n/.test(t)) st.d.deposit = /sure/.test(t) ? 'not sure' : 'no'; else ok = false; }
    else if (s === 'timeline') { const m = t.match(/[123]/); if (m) st.d.timeline = ['within 3 months', '3-6 months', '6+ months'][m[0] - 1]; else ok = false; }
    else if (s === 'where') { if (/abroad|diaspora|outside/.test(t)) st.d.where = 'abroad'; else if (/kenya|nairobi/.test(t)) st.d.where = 'Kenya'; else ok = false; }
    if (!ok) return text(from, `Sorry, I did not catch that. ${Q[s]}`);
    const next = ORDER[ORDER.indexOf(s) + 1];
    if (next) { st.step = next; await redis.set(key, st); return text(from, Q[next]); }
    st.step = 'done'; await redis.set(key, st); await saveLead(from, st);
    return text(from, `Thank you, ${st.d.name}. The agent will contact you here. In the meantime reply VIDEO for the walkthrough, FLYERS, DETAILS for payment and offer information, or VIEWING to request a site visit.`);
  }
  return answer(from, t, st);
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const q = req.query;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(q['hub.challenge']);
    return res.status(403).end();
  }
  if (req.method !== 'POST') return res.status(405).end();
  const body = await raw(req);
  const sig = String(req.headers['x-hub-signature-256'] || '');
  const exp = 'sha256=' + crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET || '').update(body).digest('hex');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return res.status(401).end();
  const data = JSON.parse(body.toString());
  for (const e of data.entry || []) for (const c of e.changes || []) for (const m of c.value?.messages || []) {
    if (m.type === 'text') { try { await handle(m.from, m.text.body.trim()); } catch (err) { console.error(err); } }
  }
  res.status(200).end();
}
