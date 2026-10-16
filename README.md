# Property Desk (self-hosted)

Daily scheduled collector -> Upstash Redis -> /api/listings -> the Desk page (Listings and Match a client).

## Deploy
1. Push this folder to a GitHub repo and import it in Vercel.
2. In Vercel > Storage, add an Upstash Redis database (Marketplace). It sets UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for you.
3. Add an environment variable CRON_SECRET (any long random string). Vercel sends it to the cron route.
4. Edit sources.json: set your contact_email, and add only sources you have permission to collect from, then set permission_confirmed to true for each.
5. Redeploy. The cron runs daily at 03:00 UTC (Hobby plans allow daily). To run now:
   curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://YOUR-APP.vercel.app/api/collect

## Built-in safeguards
- Skips any source without permission_confirmed: true
- Skips a page if robots.txt blocks it or cannot be read
- Smart parser normalizes Kenyan property prices (e.g. 15.5M, 85K, price ranges), bedrooms, and sizes (sqft to m²)
- Execution time budget guard prevents 504 timeouts on Vercel by safely persisting data before the limit
- Identifies itself, waits between requests, collects phone numbers only where the source publishes them for enquiries
- Every record carries its source link and collection date
- If a source fails, its previous data is kept

## Local Development
Run with Vercel CLI:
```bash
npm run dev
```

## Before real use
Check each site's terms, register with the ODPC as required under the Data Protection Act 2019, and add a privacy notice.
