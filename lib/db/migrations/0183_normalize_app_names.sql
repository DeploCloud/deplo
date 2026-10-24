-- An app still named like a slug reads as a title, as a new repo import names it: "fenix-ui" becomes "Fenix UI".
-- Only the display name moves; the slug, and so every container and volume, stays.
UPDATE "apps" SET "name" = (
	SELECT string_agg(
		CASE
			WHEN lower(w) = ANY ('{ai,api,aws,cd,cdn,ci,cli,cms,crm,css,csv,db,dns,gcp,html,http,https,id,json,jwt,llm,mcp,ml,os,pdf,pwa,qa,rss,s3,sdk,seo,smtp,sql,ssh,ssl,sso,tls,ui,url,ux,vpn,xml}'::text[]) THEN upper(w)
			WHEN w ~ '[A-Z]' THEN w
			ELSE upper(left(w, 1)) || substr(w, 2)
		END, ' ' ORDER BY i)
	FROM regexp_split_to_table("name", '[-_]+') WITH ORDINALITY AS t(w, i)
	WHERE w <> ''
)
WHERE "name" ~ '^[A-Za-z0-9_-]+$' AND "name" ~ '[A-Za-z0-9]' AND ("name" = lower("name") OR "name" ~ '[-_]');
