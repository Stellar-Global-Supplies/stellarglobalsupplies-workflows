-- Add 'needs_review' to leads status CHECK constraint
ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_status_check;

ALTER TABLE leads
  ADD CONSTRAINT leads_status_check
  CHECK (status IN ('pending','emailed','followed_up','converted','rejected','needs_review'));