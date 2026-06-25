-- Paid-ad tracking. Stores the per-brewery Meta Marketing API credentials so
-- the /ads dashboard can pull live campaign performance (spend, reach, clicks,
-- CTR, CPC, ROAS) from graph.facebook.com.
--
-- NOTE: this is a DIFFERENT token from meta_access_token (which is the
-- Instagram-login token used for publishing). The ads token must come from a
-- FACEBOOK app and carry the `ads_read` scope. The ad account id looks like
-- `act_1234567890`.
--
-- No insights table is needed: the Marketing API returns historical data for
-- any date window, so the dashboard fetches live on demand.

alter table brewery_configs add column if not exists meta_ad_account_id text;  -- act_1234567890
alter table brewery_configs add column if not exists meta_ads_token     text;  -- Facebook-app token with ads_read
