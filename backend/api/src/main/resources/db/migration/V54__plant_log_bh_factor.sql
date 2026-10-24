-- The Bhagiratha supply meter's dial counts in 10 KL steps: KL = (closing - opening) x 10. The server had stored closing - opening, ten times
-- too small; the rows it worked out itself (KL exactly closing - opening) are corrected. A KL typed in without readings is left as it is.
UPDATE assets.plant_log SET bh_kl = (bh_close - bh_open) * 10
WHERE bh_open IS NOT NULL AND bh_close IS NOT NULL AND bh_kl IS NOT NULL AND bh_kl = bh_close - bh_open AND bh_close > bh_open;
