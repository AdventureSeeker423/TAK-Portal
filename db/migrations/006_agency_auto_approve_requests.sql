ALTER TABLE agencies
  ADD COLUMN IF NOT EXISTS auto_approve_requests BOOLEAN NOT NULL DEFAULT false;
