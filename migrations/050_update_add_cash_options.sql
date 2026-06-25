-- Update Add Cash options to make instant cash uplift modest and bonus under 50
UPDATE add_cash_options
SET instant_cash = 0, bonus = 10
WHERE id = 1;

UPDATE add_cash_options
SET instant_cash = 10, bonus = 20
WHERE id = 2;

UPDATE add_cash_options
SET instant_cash = 20, bonus = 40
WHERE id = 3;

UPDATE add_cash_options
SET instant_cash = 40, bonus = 50
WHERE id = 4;

UPDATE add_cash_options
SET instant_cash = 50, bonus = 60
WHERE id = 5;
