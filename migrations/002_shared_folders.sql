CREATE TABLE shared_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE share_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shared_folder_id UUID NOT NULL REFERENCES shared_folders(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  voter_name TEXT NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('liked', 'unliked')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shared_folder_id, media_id, voter_name)
);
