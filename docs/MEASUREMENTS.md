# Measurement log: do Search Archive fetches use SerpApi search credits?

SerpApi's [Search Archive API page](https://serpapi.com/search-archive-api) does not say whether
`GET /searches/{id}.json` costs credits, and it does not mention the `json_endpoint` link at all. The
[Account API](https://serpapi.com/account-api) is documented as free ("will not be counted toward your monthly quota"),
so we used it to read `this_month_usage` before and after archive fetches.

**Small sample, one free-plan account, one day.** The usage counter can lag a few seconds behind a search (see run 1),
so read the totals, not single steps. SerpApi may change this behaviour at any time. That is why archive fetches stay in the
local ledger, and why `SERP_RECEIPTS_ARCHIVE_COUNTS=1` can count them against the cap.

## Run 1: 4 searches, each followed by 1 archive fetch (`scripts/record.ts`)

Time: 2026-10-08 20:17 UTC (9 Oct 01:47 IST). Each line reads usage before the search, 4 s after the search,
and 4 s after the archive fetch. Raw output:

```
google_scholar "Indian summer monsoon rainfall prediction" -> 6ac7fa48b463f3dd8d9a3626 (LIVE); account usage: before search 25, after search 26, after archive fetch 26
google "India UPI transactions September 2026" -> 6ac7fa520257bb12b6254209 (LIVE); account usage: before search 26, after search 26, after archive fetch 27
google_news "ISRO launch" -> 6ac7fa5c5922f46d17bd393a (LIVE); account usage: before search 27, after search 27, after archive fetch 28
google_shopping "stainless steel pressure cooker 5 litre" -> 6ac7fa6759eb370ef6d485e5 (LIVE); account usage: before search 28, after search 29, after archive fetch 29
ledger: 4/40 credits, 4 archive fetches
```

Total: usage went 25 → 29 for 4 searches + 4 archive fetches. The +1 steps that show up "after archive fetch" on lines 2–3
are the preceding search being counted late (the counter lagged): there are exactly 4 increments for 4 searches.

## Run 2: archive fetches only, then wait 30 s

Time: 2026-10-08 20:18:12 UTC (local ledger timestamps 20:18:12.352Z, 20:18:12.676Z, 20:18:12.950Z). Raw output
(the second number is `plan_searches_left`):

```
before 29 221
6ac7fa48b463f3dd8d9a3626 200 true
6ac7fa520257bb12b6254209 200 true
6ac7fa5c5922f46d17bd393a 200 true
after 30s 29 221
```

Result: 3 archive fetches (HTTP 200, JSON returned) left both `this_month_usage` (29) and `plan_searches_left` (221) unchanged.

## Run 3: keyless `json_endpoint` (no API key sent)

Time: between 20:18 and 20:21 UTC on 2026-10-08 (curl, not logged in the ledger; the 20:21:27 ledger entry below is a keyless `serp-receipts verify` run). We sent `GET` with no `api_key` to these two URLs:
- the `search_metadata.json_endpoint` URL of search 6ac7fa48b463f3dd8d9a3626 (`https://serpapi.com/searches/<token>/<id>.json`);
- the plain Search Archive URL `https://serpapi.com/searches/6ac7fa48b463f3dd8d9a3626.json`.

```
token url, no key: 200
plain /searches/id.json, no key: 401
```

A full `verify_receipt` over the json_endpoint with no key returned VERIFIED (claim cited_by = 251), and the inflated claim
(99999) returned MISMATCH ("archive says 251"). We re-checked keyless verification on 9 Oct 2026 with `serp-receipts demo`
from a clean install (no key): VERIFIED / MISMATCH, `archive_via: json_endpoint`.

## Ledger excerpt (`data/ledger.json`, local, gitignored)

```
2026-10-08T20:17:13.138Z search  google_scholar  6ac7fa48b463f3dd8d9a3626 credit 1
2026-10-08T20:17:17.813Z archive                 6ac7fa48b463f3dd8d9a3626 credit 0
2026-10-08T20:17:23.301Z search  google          6ac7fa520257bb12b6254209 credit 1
2026-10-08T20:17:28.038Z archive                 6ac7fa520257bb12b6254209 credit 0
2026-10-08T20:17:33.971Z search  google_news     6ac7fa5c5922f46d17bd393a credit 1
2026-10-08T20:17:38.655Z archive                 6ac7fa5c5922f46d17bd393a credit 0
2026-10-08T20:17:50.738Z search  google_shopping 6ac7fa6759eb370ef6d485e5 credit 1
2026-10-08T20:17:55.440Z archive                 6ac7fa6759eb370ef6d485e5 credit 0
2026-10-08T20:18:12.352Z archive                 6ac7fa48b463f3dd8d9a3626 credit 0
2026-10-08T20:18:12.676Z archive                 6ac7fa520257bb12b6254209 credit 0
2026-10-08T20:18:12.950Z archive                 6ac7fa5c5922f46d17bd393a credit 0
2026-10-08T20:21:27.413Z archive                 6ac7fa48b463f3dd8d9a3626 credit 0
```

("credit" here is what this tool's ledger charges, not a SerpApi number. The SerpApi numbers are the usage readings above.)
