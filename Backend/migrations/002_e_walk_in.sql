-- 002_e_walk_in.sql: "E Walk-In", joining the salon's walk-in line from the app.
--
-- A customer can either let the salon assign a stylist at random (from the
-- stylists who take part in E Walk-In) or ask for one stylist by name. The desk
-- controls it with a salon-wide switch and a per-stylist switch.

-- Salon-wide switch. When off, the app refuses E Walk-In joins (E_WALK_IN_DISABLED).
ALTER TABLE salons
  ADD COLUMN e_walk_in_enabled boolean NOT NULL DEFAULT true;

-- Per-stylist switch. false = this stylist is out of the random pool and cannot
-- be requested through E Walk-In (customers already in their line stay).
ALTER TABLE stylists
  ADD COLUMN e_walk_in_enabled boolean NOT NULL DEFAULT true;

-- How the entry was created, so the desk can see which customers came through E Walk-In.
-- 'standard' covers desk-added walk-ins and joins made before this migration.
ALTER TABLE queue_entries
  ADD COLUMN join_mode text NOT NULL DEFAULT 'standard'
    CHECK (join_mode IN ('standard', 'e_walk_in'));
