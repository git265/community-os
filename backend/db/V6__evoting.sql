-- Round 74: the second factor of e-voting. The one-time code the owner is sent, the single-use proof it turns into, and the one
-- ballot-box write a verified voter-roll mark allows used to live in the memory of one server process. They are kept here so a restart or a
-- second server instance does not lose them, and so that a proof can be taken (and so used up) exactly once.
--   kind = 'challenge'  k = ballot|unit|owner       hash = salted SHA-256 of the code      salt, tries, sent_at used
--   kind = 'proof'      k = SHA-256 of the token    hash = the ballot|unit|owner it is for
--   kind = 'allowance'  k = ballot|unit|owner       (one ballot-box write is allowed)
-- Nothing here is a vote: the ballot box itself is the `ballotBox` collection, and it never records who voted.
CREATE TABLE IF NOT EXISTS evoting_state (
  tenant   text   NOT NULL,
  kind     text   NOT NULL,
  k        text   NOT NULL,
  salt     text,
  hash     text,
  exp      bigint NOT NULL DEFAULT 0,      -- epoch milliseconds
  tries    integer NOT NULL DEFAULT 0,
  sent_at  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, kind, k)
);
CREATE INDEX IF NOT EXISTS evoting_state_exp ON evoting_state (exp);
