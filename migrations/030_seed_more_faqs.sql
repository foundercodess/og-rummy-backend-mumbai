-- Add more FAQs for existing installations (029 already seeded 3)
-- These are inserted only if they don't already exist (by question)
INSERT INTO faqs (question, answer, active, sort_order)
SELECT * FROM (VALUES
  ('Why is KYC required?', 'KYC (Know Your Customer) is required by law for cash withdrawals. It helps us verify your identity and keep the platform secure. Higher KYC levels allow larger withdrawal limits.', true, 3),
  ('How do I claim daily rewards?', 'Log in daily and visit the Daily Rewards section. Claim your reward each day to progress through the 7-day ladder. Rewards are credited to your wallet instantly.', true, 4),
  ('What Rummy games can I play?', 'We offer Points Rummy, 101 Pool, 201 Pool, Deals, Spin & Go, and Practice. Each has different rules and contest types. Check the Games section for details.', true, 5),
  ('How does the entry fee work?', 'Each contest has an entry fee. Pay the fee to join; winners share the prize pool. Check contest details for entry amount and win potential before joining.', true, 6),
  ('When do I receive my winnings?', 'Winnings from games are credited to your wallet immediately after the contest ends. You can withdraw them after completing KYC if required.', true, 7),
  ('Is my money and data safe?', 'Yes. We use secure payment gateways and follow industry standards. Your personal and financial data is encrypted and never shared with third parties.', true, 8),
  ('What payment methods do you accept?', 'We accept UPI, debit cards, credit cards, and net banking for add cash. Withdrawal is processed to your verified bank account or UPI.', true, 9),
  ('Is there a withdrawal limit?', 'Withdrawal limits depend on your KYC level. Basic KYC allows moderate limits; full KYC enables higher withdrawal amounts. Check Wallet > Withdraw for options.', true, 10),
  ('Can I play for free?', 'Yes. Practice games let you play Rummy without real money. Use them to learn rules and improve your skills before joining cash contests.', true, 11),
  ('How can I change my profile or avatar?', 'Go to Profile/Settings and select an avatar from the available options. You can also update your display name and other details there.', true, 12),
  ('I added cash but it did not reflect. What do I do?', 'Add cash usually reflects within minutes. If it does not, check your transaction status in Wallet > Recharge History. If the payment succeeded but balance did not update, contact support with your order ID.', true, 13),
  ('Which states can play on OG Rummy?', 'OG Rummy is available in Indian states where online Rummy is permitted. Please ensure you are of legal age (18+) and in a permitted state before playing.', true, 14)
) AS v(question, answer, active, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM faqs f WHERE f.question = v.question);
