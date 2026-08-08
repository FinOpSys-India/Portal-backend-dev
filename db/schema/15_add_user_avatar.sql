-- 15_add_user_avatar.sql
--
-- Give `users` a profile picture.
--
-- The column stores a KEY, not the image and not a URL:
--
--     avatars/18/9f3c2a....jpg
--
-- The bytes live on disk (or in an object store later); this is the pointer to
-- them. Storing the image itself in Postgres would drag megabytes into every
-- backup and every `SELECT *`, and would put the file behind the connection pool
-- instead of behind a static file server. Storing a full URL instead of a key
-- would bake the host into the data, so moving from local disk to a CDN would
-- mean rewriting every row rather than changing one config value.
--
-- Nullable because most users have no picture, and "no picture" is a truthful
-- state rather than a missing one. 512 characters is generous for
-- `avatars/<id>/<32 hex chars>.<ext>` and bounds what a bug could ever write.

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "avatar_key" VARCHAR(512);

COMMENT ON COLUMN "users"."avatar_key" IS
    'Storage key of the profile picture, e.g. avatars/18/9f3c2a.jpg. NULL = no picture. The public URL is built by the API; never store one here.';

-- Guard against a blank string, which would be a third state meaning the same
-- thing as NULL — and the one the frontend would render as a broken image.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_avatar_key_not_blank') THEN
        ALTER TABLE "users"
            ADD CONSTRAINT "users_avatar_key_not_blank"
            CHECK ("avatar_key" IS NULL OR length(btrim("avatar_key")) > 0);
    END IF;
END
$$;
