INSERT INTO notices (message, type, is_active, sort_order, metadata)
SELECT 'Welcome to OG Rummy. Enjoy the tables and play responsibly.', 'info', true, 1, '{"source":"migration"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM notices WHERE message = 'Welcome to OG Rummy. Enjoy the tables and play responsibly.'
);

INSERT INTO notices (message, type, is_active, sort_order, metadata)
SELECT 'Support is available from the Help section for wallet or gameplay issues.', 'warning', true, 2, '{"source":"migration"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM notices WHERE message = 'Support is available from the Help section for wallet or gameplay issues.'
);