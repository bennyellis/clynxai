-- Automatic desktop updates. The installer's SHA-512 (what the signed update manifest states) is computed by the server from the stored file; the SIGNED manifest is produced
-- offline by the person who holds the update signing key and uploaded here. The server verifies it with the PUBLIC key only and serves it; it never holds the private key.
ALTER TABLE releases ADD COLUMN IF NOT EXISTS sha512 TEXT;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS update_manifest TEXT;       -- JSON text of { manifest, signature } exactly as signed
ALTER TABLE releases ADD COLUMN IF NOT EXISTS update_manifest_at TIMESTAMPTZ;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS update_manifest_by UUID REFERENCES users(id) ON DELETE SET NULL;
