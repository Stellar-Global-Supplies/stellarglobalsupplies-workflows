-- Store large generated text payloads in the assets bucket and keep only keys/URLs in Supabase.
ALTER TABLE IF EXISTS social_posts
  ADD COLUMN IF NOT EXISTS content_s3_key TEXT;

ALTER TABLE IF EXISTS social_posts
  ADD COLUMN IF NOT EXISTS content_url TEXT;

ALTER TABLE IF EXISTS blog_posts
  ADD COLUMN IF NOT EXISTS content_s3_key TEXT;

ALTER TABLE IF EXISTS blog_posts
  ADD COLUMN IF NOT EXISTS content_url TEXT;

CREATE INDEX IF NOT EXISTS idx_social_posts_content_s3_key
  ON social_posts(content_s3_key);

CREATE INDEX IF NOT EXISTS idx_blog_posts_content_s3_key
  ON blog_posts(content_s3_key);
