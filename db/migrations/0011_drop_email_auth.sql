-- Sign-in is now "pick who you are": accounts are created from the backend and
-- a session starts as soon as one is chosen. That removes the one-time-code
-- flow, the invitation flow, and the rate limiting that existed to protect
-- them, so their tables go with it. `sessions` and `users` are untouched.
--
-- auth_codes has a FK to invitations, so it is dropped first.

DROP TABLE IF EXISTS auth_codes;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS rate_limits;
