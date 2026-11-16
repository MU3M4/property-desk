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
- Identifies itself, waits between requests, collects phone numbers only where the source publishes them for enquiries
- Every record carries its source link and collection date
- If a source fails, its previous data is kept

## Before real use
Check each site's terms, register with the ODPC as required under the Data Protection Act 2019, and add a privacy notice.

## WhatsApp client sourcing (Riverside Azure)
The assistant lives at /api/whatsapp. Clients message your WhatsApp business number first (from ads, posts, the click-to-chat link on the Riverside Azure tab). It asks for consent, qualifies the lead, answers only from data/riverside-azure.json, sends the video and flyers on request, and saves the lead. STOP deletes their data.

1. Create a Meta developer app, add the WhatsApp product and a business phone number (a number already on the normal WhatsApp app must be migrated or use a new one).
2. Webhook: callback URL https://YOUR-APP.vercel.app/api/whatsapp, your own verify token, subscribe to "messages".
3. Vercel environment variables: WHATSAPP_TOKEN (permanent system-user token), WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, PUBLIC_BASE_URL (https://YOUR-APP.vercel.app), ADMIN_KEY (any long secret, used by "Load WhatsApp leads").
4. Redeploy, then message the number to test.

Rules to respect: only message people who contacted you or opted in (Meta also limits free-form replies to 24 hours after their last message), keep consent records, and honor STOP. Update data/riverside-azure.json whenever the developer changes the offer.
