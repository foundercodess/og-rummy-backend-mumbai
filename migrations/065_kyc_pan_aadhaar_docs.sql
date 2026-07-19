-- KYC multi-doc: pan | aadhaar | both; Aadhaar requires front + back images.
ALTER TABLE kyc
  ADD COLUMN IF NOT EXISTS doc_mode VARCHAR(20) NOT NULL DEFAULT 'pan',
  ADD COLUMN IF NOT EXISTS pan_image_url VARCHAR(500),
  ADD COLUMN IF NOT EXISTS pan_card_no VARCHAR(50),
  ADD COLUMN IF NOT EXISTS aadhaar_front_image_url VARCHAR(500),
  ADD COLUMN IF NOT EXISTS aadhaar_back_image_url VARCHAR(500),
  ADD COLUMN IF NOT EXISTS aadhaar_card_no VARCHAR(20);

-- Backfill legacy single-image KYC rows as PAN.
UPDATE kyc
SET
  pan_image_url = COALESCE(pan_image_url, image_url),
  pan_card_no = COALESCE(pan_card_no, card_no),
  doc_mode = COALESCE(NULLIF(TRIM(doc_mode), ''), 'pan')
WHERE image_url IS NOT NULL OR card_no IS NOT NULL;

COMMENT ON COLUMN kyc.doc_mode IS 'pan | aadhaar | both — what the user submitted';
COMMENT ON COLUMN kyc.aadhaar_front_image_url IS 'Aadhaar front image URL (required when aadhaar/both)';
COMMENT ON COLUMN kyc.aadhaar_back_image_url IS 'Aadhaar back image URL (required when aadhaar/both)';
