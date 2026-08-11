-- How big a backup artifact is once its age layer is off.
--
-- The download route decrypts on the way out, so the bytes it hands the browser
-- are NOT `size_bytes` (that is the ciphertext, which is what landed at the
-- destination). Nobody held both numbers: the agent that wrote the artifact saw
-- them and reported only one, so the download could send no Content-Length, and
-- a browser with no Content-Length shows a download with no size, no percentage
-- and no estimate. It looks like it is running forever.
--
-- NULL means "not recorded": every existing run, plus any written by an agent
-- older than the field. Those downloads keep behaving exactly as they do today
-- rather than advertising a length that would be wrong.

ALTER TABLE "backup_runs" ADD COLUMN "decrypted_size_bytes" bigint;
